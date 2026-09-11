import { AuthError } from "./auth.ts";
import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { canonicalProof, authSecrets, refuse } from "./auth-primitives.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { Settings, SettingsChange, canonicalSettings, readSettings, readPublicPaths } from "./settings-schema.ts";

const Receipt = Schema.Struct({
	session: Schema.String,
	binding: Schema.String,
	proof: Schema.String,
	result: Settings,
});
/** Authorization, policy, audit event and exact replay receipt have one SQL commit. */
export const makeSettings = <E, R>(
	verify: (params: SettingsChange, proof: AssertionProof, session: string) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const { hash } = authSecrets(yield* Crypto.Crypto);
		const current = readSettings.pipe(Effect.provideService(SqlClient.SqlClient, sql));
		return {
			settings: current,
			publicPaths: readPublicPaths.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.orElseSucceed((): readonly string[] => []),
			),
			changeSettings: (params: SettingsChange, proof: AssertionProof, session: string) =>
				mutex.withPermit(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* Schema.decodeUnknownEffect(SettingsChange)(params, { onExcessProperty: "error" }).pipe(
								Effect.mapError(() => new AuthError({ code: "invalid_request" })),
							);
							const liveSession = Effect.gen(function* () {
								const now = yield* Clock.currentTimeMillis;
								if (!(yield* sql`SELECT id FROM sessions WHERE id=${session} AND expires_at>${now}`).length)
									return yield* refuse("session_invalid");
							});
							yield* liveSession;
							const binding = canonicalSettings(params, session);
							const digest = yield* hash(canonicalProof(proof));
							const key = `settings.receipt:${yield* hash(proof.id)}`;
							const row = (yield* sql`SELECT value FROM settings WHERE key=${key}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
							))[0];
							if (row) {
								const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(row.value);
								if (receipt.session !== session || receipt.proof !== digest) return yield* refuse("assertion_invalid");
								if (receipt.binding !== binding) return yield* refuse("settings_conflict");
								return receipt.result;
							}
							yield* verify(params, proof, session);
							yield* liveSession;
							const before = yield* current;
							if (before.revision !== params.revision) return yield* refuse("settings_conflict");
							const result = { ...before, ...params.patch, revision: before.revision + 1 };
							if (!Number.isSafeInteger(result.revision)) return yield* refuse("invalid_request");
							for (const [name, value] of [
								["event_retention", result.event_retention],
								["storage_policy", result.storage],
								["public_paths", result.public_paths],
								["settings_revision", result.revision],
							] as const) {
								const encoded = JSON.stringify(value);
								yield* sql`INSERT INTO settings (key,value) VALUES (${name},${encoded}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
							}
							const receipt = JSON.stringify({ session, binding, proof: digest, result });
							yield* sql`INSERT INTO settings (key,value) VALUES (${key},${receipt})`;
							yield* events.writeBoot({
								at: yield* Clock.currentTimeMillis,
								type: "settings.changed",
								level: "info",
								actor: "rahul",
								instance: session,
								generation: 0,
								request_id: null,
								topic: null,
								message_id: null,
								payload: { revision: result.revision, keys: Object.keys(params.patch) },
							});
							yield* liveSession;
							return result;
						}),
					),
				),
		};
	});
