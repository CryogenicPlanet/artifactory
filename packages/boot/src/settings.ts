import { on } from "@comms/storage/dialect";
import { lockBootWrite } from "./boot-write-lock.ts";
import { humanAgent } from "./human-agent.ts";
import { AuthError } from "./auth.ts";
import { Clock, Crypto, Effect, Option, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { canonicalProof, authSecrets, refuse } from "./auth-primitives.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import {
	EventRetention,
	Settings,
	SettingsChange,
	canonicalSettings,
	readSettings,
	readPublicPaths,
} from "./settings-schema.ts";

const Receipt = Schema.Struct({
	session: Schema.String,
	expires_at: Schema.Int,
	binding: Schema.String,
	proof: Schema.String,
	result: Schema.Struct({ ...Settings.fields, event_retention: Schema.optionalKey(EventRetention) }),
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
		const save = (key: string, value: string) =>
			sql`INSERT INTO settings (${sql("key")},value) VALUES (${key},${value}) ${on(sql, {
				sqlite: () => sql`ON CONFLICT(${sql("key")}) DO UPDATE SET value=excluded.value`,
				pg: () => sql`ON CONFLICT(${sql("key")}) DO UPDATE SET value=excluded.value`,
				mysql: () => sql`AS incoming ON DUPLICATE KEY UPDATE value=incoming.value`,
			})}`;
		// Receipt values are text and may contain damaged legacy JSON. Decode the bounded
		// window without a remote JSON cast turning cleanup into an auth outage.
		const expireRemote = (first: string, last: string, now: number) =>
			Effect.gen(function* () {
				const rows =
					yield* sql`SELECT ${sql("key")},value FROM settings WHERE ${sql("key")}>=${first} AND ${sql("key")}<=${last}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
						),
					);
				for (const row of rows) {
					const receipt = Schema.decodeUnknownOption(
						Schema.fromJsonString(
							Schema.Struct({ expires_at: Schema.Finite, session: Schema.optionalKey(Schema.String) }),
						),
					)(row.value);
					if (Option.isSome(receipt) && receipt.value.expires_at <= now)
						yield* sql`DELETE FROM settings WHERE ${sql("key")}=${row.key} AND NOT EXISTS (SELECT 1 FROM sessions WHERE id=${receipt.value.session ?? null} AND expires_at>${now})`;
				}
			});
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
							yield* lockBootWrite(sql);
							yield* Schema.decodeUnknownEffect(SettingsChange)(params, { onExcessProperty: "error" }).pipe(
								Effect.mapError(() => new AuthError({ code: "invalid_request" })),
							);
							const liveSession = Effect.gen(function* () {
								const now = yield* Clock.currentTimeMillis;
								const row = (yield* sql`SELECT expires_at FROM sessions WHERE id=${session} AND expires_at>${now}`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ expires_at: Schema.Int })))),
								))[0];
								if (!row) return yield* refuse("session_invalid");
								return row.expires_at;
							});
							const expires_at = yield* liveSession;
							const now = yield* Clock.currentTimeMillis;
							// Advance a durable bounded key window; live receipts cannot starve expired ones later in the range.
							const cursorRow =
								(yield* sql`SELECT value FROM settings WHERE ${sql("key")}='settings.receipt_cursor'`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
								))[0];
							const cursor = cursorRow?.value ?? "settings.receipt:";
							const window = (after: string) =>
								sql`SELECT ${sql("key")} FROM settings WHERE ${sql("key")}>${after} AND ${sql("key")}>='settings.receipt:' AND ${sql("key")}<'settings.receipt;' ORDER BY ${sql("key")} LIMIT 256`.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String })))),
								);
							let candidates = yield* window(cursor);
							if (candidates.length === 0 && cursor !== "settings.receipt:")
								candidates = yield* window("settings.receipt:");
							const first = candidates[0]?.key;
							const last = candidates.at(-1)?.key;
							if (first !== undefined && last !== undefined) {
								yield* on(sql, {
									sqlite: () => sql`DELETE FROM settings WHERE ${sql("key")}>=${first} AND ${sql("key")}<=${last}
 AND CASE WHEN json_valid(value) THEN json_extract(value,'$.expires_at') END <= ${now}
 AND NOT EXISTS (SELECT 1 FROM sessions WHERE id=CASE WHEN json_valid(value) THEN json_extract(value,'$.session') END AND expires_at>${now})`,
									pg: () => expireRemote(first, last, now),
									mysql: () => expireRemote(first, last, now),
								});
							}
							const nextCursor = last ?? "settings.receipt:";
							yield* save("settings.receipt_cursor", nextCursor);
							const binding = canonicalSettings(params, session);
							const digest = yield* hash(canonicalProof(proof));
							const key = `settings.receipt:${yield* hash(proof.id)}`;
							const row = (yield* sql`SELECT value FROM settings WHERE ${sql("key")}=${key}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
							))[0];
							if (row) {
								const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(row.value);
								if (receipt.session !== session || receipt.proof !== digest) return yield* refuse("assertion_invalid");
								if (receipt.binding !== binding) return yield* refuse("settings_conflict");
								return receipt.result;
							}
							// Retired settings may replay an accepted receipt, but can never create a new mutation.
							if (params.patch.event_retention !== undefined) return yield* refuse("invalid_request");
							yield* verify(params, proof, session);
							yield* liveSession;
							const before = yield* current;
							if (before.revision !== params.revision) return yield* refuse("settings_conflict");
							const result = { ...before, ...params.patch, revision: before.revision + 1 };
							if (!Number.isSafeInteger(result.revision)) return yield* refuse("invalid_request");
							for (const [name, value] of [
								["storage_policy", result.storage],
								["public_paths", result.public_paths],
								["settings_revision", result.revision],
							] as const) {
								const encoded = JSON.stringify(value);
								yield* save(name, encoded);
							}
							const receipt = JSON.stringify({ session, expires_at, binding, proof: digest, result });
							yield* sql`INSERT INTO settings (${sql("key")},value) VALUES (${key},${receipt})`;
							yield* events.writeBoot({
								at: yield* Clock.currentTimeMillis,
								type: "settings.changed",
								level: "info",
								actor: humanAgent,
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
