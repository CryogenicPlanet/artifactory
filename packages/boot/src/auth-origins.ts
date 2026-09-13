import { committed, captureRefusal, refuse } from "./auth-primitives.ts";
import { Clock, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError, type AuthConfig } from "./auth.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { humanAgent } from "./human-agent.ts";
import { canonicalOriginRemove, type RemoveOrigin } from "./passkey-code-schema.ts";

/** One browser origin and the WebAuthn relying party ID its passkeys are bound to. */
export interface RelyingParty {
	readonly rpId: string;
	readonly expectedOrigin: string;
}

/** https (http only for localhost), an exact origin, and a bare RP ID that contains the origin's host. */
export const validRelyingParty = (party: RelyingParty) => {
	if (
		party.expectedOrigin.length > 512 ||
		!URL.canParse(party.expectedOrigin) ||
		!URL.canParse(`https://${party.rpId}`)
	)
		return false;
	const origin = new URL(party.expectedOrigin);
	const rp = new URL(`https://${party.rpId}`);
	// URL accepts characters such as "*" in hostnames; an origin is only ever an exact DNS name.
	const hostname = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
	return (
		hostname.test(origin.hostname) &&
		hostname.test(party.rpId) &&
		origin.origin === party.expectedOrigin &&
		!origin.username &&
		!origin.password &&
		rp.hostname === party.rpId &&
		!rp.port &&
		rp.pathname === "/" &&
		(origin.hostname === party.rpId || origin.hostname.endsWith(`.${party.rpId}`)) &&
		(origin.protocol === "https:" || (origin.protocol === "http:" && origin.hostname === "localhost"))
	);
};

/** An origin named without an explicit RP ID binds its passkeys to its own hostname. */
export const originRelyingParty = (origin: string): RelyingParty | null => {
	if (!URL.canParse(origin)) return null;
	const party = { rpId: new URL(origin).hostname, expectedOrigin: origin };
	return validRelyingParty(party) ? party : null;
};

/** The primary origin comes first: boot uses it wherever it generates an absolute URL. */
export const configuredParties = (config: AuthConfig): ReadonlyArray<RelyingParty> => [
	{ rpId: config.rpId, expectedOrigin: config.expectedOrigin },
	...(config.additionalOrigins ?? []),
];

const originRow = Schema.Struct({ origin: Schema.String, rp_id: Schema.String });

/** Configured origins plus origins a redeemed passkey code activated. Matching is exact; nothing is a suffix rule. */
export const allowedParties = (sql: SqlClient.SqlClient, config: AuthConfig) =>
	Effect.gen(function* () {
		const configured = configuredParties(config);
		const rows = yield* Schema.decodeUnknownEffect(Schema.Array(originRow))(
			yield* sql`SELECT origin, rp_id FROM auth_origins ORDER BY created_at, origin`,
		);
		return [
			...configured,
			...rows
				.filter((row) => !configured.some((party) => party.expectedOrigin === row.origin))
				.map((row) => ({ rpId: row.rp_id, expectedOrigin: row.origin })),
		];
	});

/** Why no allowed origin can sign in with any stored passkey, or null when at least one can. Pure, so the caller
 * decides whether a mismatch refuses startup or only warns. */
export const passkeyOriginMismatch = (
	passkeyRpIds: ReadonlyArray<string>,
	parties: ReadonlyArray<RelyingParty>,
): string | null =>
	passkeyRpIds.length === 0 || passkeyRpIds.some((rpId) => parties.some((party) => party.rpId === rpId))
		? null
		: `no passkey uses an RP ID served by an allowed origin (passkeys use ${passkeyRpIds.join(", ")}; allowed origins serve ${[...new Set(parties.map((party) => party.rpId))].join(", ")}), so nobody could sign in`;

const codeRow = Schema.Struct({ origin: Schema.NullOr(Schema.String), expires_at: Schema.Finite });
const countRow = Schema.Struct({ rp_id: Schema.NullOr(Schema.String) });

/** Human listing and removal of runtime origins. Configured origins are read-only here. */
export const makeOriginManagement = <E, R>(
	config: AuthConfig,
	verify: (binding: string, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const liveSession = (sessionId: string) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
					return yield* refuse("session_invalid");
			});
		const listOrigins = (sessionId: string) =>
			mutex.withPermit(
				Effect.gen(function* () {
					yield* liveSession(sessionId);
					const now = yield* Clock.currentTimeMillis;
					const configured = configuredParties(config);
					const parties = yield* allowedParties(sql, config);
					const keys = yield* Schema.decodeUnknownEffect(Schema.Array(countRow))(
						yield* sql`SELECT rp_id FROM passkeys`,
					);
					const code = (yield* Schema.decodeUnknownEffect(Schema.Array(codeRow))(
						yield* sql`SELECT origin, expires_at FROM passkey_codes WHERE expires_at>${now}`,
					))[0];
					// A passkey stored before RP IDs were recorded belongs to the primary RP ID until a signature stamps it.
					const passkeys = (rpId: string) => keys.filter((key) => (key.rp_id ?? config.rpId) === rpId).length;
					const items = parties.map((party) => {
						const fromConfig = configured.some((item) => item.expectedOrigin === party.expectedOrigin);
						return {
							origin: party.expectedOrigin,
							rp_id: party.rpId,
							source: fromConfig ? ("config" as const) : ("runtime" as const),
							status: "active" as const,
							passkeys: passkeys(party.rpId),
							removable: !fromConfig,
						};
					});
					const pending = code?.origin ? originRelyingParty(code.origin) : null;
					return {
						items:
							pending && !parties.some((party) => party.expectedOrigin === pending.expectedOrigin)
								? [
										...items,
										{
											origin: pending.expectedOrigin,
											rp_id: pending.rpId,
											source: "code" as const,
											status: "pending" as const,
											passkeys: passkeys(pending.rpId),
											removable: false,
											expires_at: code?.expires_at,
										},
									]
								: items,
					};
				}),
			);
		const removeOrigin = (params: RemoveOrigin, proof: AssertionProof, sessionId: string, party: RelyingParty) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!originRelyingParty(params.origin)) return yield* refuse("invalid_request");
						yield* verify(yield* canonicalOriginRemove(params, sessionId), proof);
						yield* liveSession(sessionId);
						if (
							params.origin === party.expectedOrigin ||
							configuredParties(config).some((item) => item.expectedOrigin === params.origin)
						)
							return yield* refuse("origin_protected");
						const row = (yield* Schema.decodeUnknownEffect(Schema.Array(originRow))(
							yield* sql`SELECT origin, rp_id FROM auth_origins WHERE origin=${params.origin}`,
						))[0];
						if (!row) return yield* refuse("origin_not_found");
						// Passkeys for this RP ID stay usable when another allowed origin serves the same RP ID.
						const served = (yield* allowedParties(sql, config)).some(
							(item) => item.expectedOrigin !== row.origin && item.rpId === row.rp_id,
						);
						if (
							!served &&
							(yield* sql`SELECT id FROM passkeys WHERE COALESCE(rp_id, ${config.rpId})=${row.rp_id} LIMIT 1`).length
						)
							return yield* refuse("origin_has_passkeys");
						yield* sql`DELETE FROM auth_origins WHERE origin=${row.origin}`;
						// Sessions issued on the removed origin end with it. A session with no recorded origin predates
						// runtime origins and counts as the primary origin's, which is never removable here.
						yield* sql`DELETE FROM sessions WHERE origin=${row.origin}`;
						const now = yield* Clock.currentTimeMillis;
						yield* events.writeBoot({
							at: now,
							type: "auth.origin_removed",
							level: "info",
							actor: humanAgent,
							instance: null,
							generation: 0,
							request_id: null,
							topic: null,
							message_id: null,
							payload: { origin: row.origin, rp_id: row.rp_id },
						});
						return { removed: row.origin };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
		return { listOrigins, removeOrigin };
	});
