import { layer as durableEventsLayer } from "../../src/events.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Context, Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import type { RelyingParty } from "../../src/auth-origins.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { authenticator } from "./authenticator.ts";

const lockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const primary: RelyingParty = { rpId: "comms.test", expectedOrigin: "https://comms.test" };
const other: RelyingParty = { rpId: "other.test", expectedOrigin: "https://other.test" };
const added: RelyingParty = { rpId: "new.test", expectedOrigin: "https://new.test" };
// A primary origin whose RP ID is its parent domain, so a runtime origin on that parent shares the RP ID.
const board: RelyingParty = { rpId: "comms.test", expectedOrigin: "https://board.comms.test" };

const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const output: string[] = [];
	const captured: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const start = (configured: RelyingParty = primary, originList = false) =>
		Layer.build(
			authLayer({ ...configured, additionalOrigins: [other], originList }).pipe(
				Layer.provide(Layer.mergeAll(lockLayer, eventsLayer(Effect.void))),
			),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result), `expected ${code}, got success`);
				const failure: unknown = result.failure;
				assert.ok(
					typeof failure === "object" && failure !== null && "code" in failure && failure.code === code,
					`expected ${code}, got ${String(failure)}`,
				);
			}),
		);
	const base = scenario === "shared-rp" ? board : primary;
	let auth = yield* start(base);
	const first = authenticator(),
		second = authenticator();
	const counters = new Map<string, number>();
	const sign = (device: ReturnType<typeof authenticator>, challenge: string, party: RelyingParty) => {
		const counter = (counters.get(device.id) ?? 0) + 1;
		counters.set(device.id, counter);
		return device.assertion(challenge, counter, party.expectedOrigin, party.rpId);
	};
	const setupCode = output.at(-1)?.split("code ")[1];
	assert.ok(setupCode);
	const setup = yield* auth.startSetup(setupCode);
	yield* auth.finishSetup(setup.id, first.registration(setup.options.challenge, base.expectedOrigin, base.rpId));
	const login = (device: ReturnType<typeof authenticator>, party: RelyingParty) =>
		Effect.gen(function* () {
			const challenge = yield* auth.at(party).startLogin;
			return yield* auth.at(party).finishLogin(challenge.id, sign(device, challenge.options.challenge, party));
		});
	const session = yield* login(first, base);
	const codeProof = (params: { readonly origin?: string }, party = base, device = first) =>
		Effect.gen(function* () {
			const challenge = yield* auth.at(party).startPasskeyCodeAssertion(params, session.id);
			return { id: challenge.id, response: sign(device, challenge.options.challenge, party) };
		});
	const create = (params: { readonly origin?: string } = {}) =>
		Effect.gen(function* () {
			return yield* auth.createPasskeyCode(params, yield* codeProof(params), session.id);
		});
	const redeem = (code: string, device: ReturnType<typeof authenticator>, party: RelyingParty) =>
		Effect.gen(function* () {
			const started = yield* auth.startPasskeyCodeRedemption(code, party.expectedOrigin);
			assert.equal(started.options.rp.id, party.rpId);
			return yield* auth.finishPasskeyCodeRedemption(
				started.id,
				device.registration(started.options.challenge, party.expectedOrigin, party.rpId),
				party.expectedOrigin,
			);
		});

	if (scenario === "origins") {
		// Every configured origin resolves exactly; anything else, including a subdomain or a trailing slash, is refused.
		assert.deepEqual(yield* auth.relyingParty("https://comms.test"), primary);
		assert.deepEqual(yield* auth.relyingParty("https://other.test"), other);
		for (const origin of [
			"https://evil.test",
			"https://sub.comms.test",
			"https://comms.test/",
			"http://comms.test",
			undefined,
		])
			yield* fails(auth.relyingParty(origin), "origin_invalid");
		// A passkey registered under comms.test never verifies on other.test, whichever RP ID the response claims.
		const otherLogin = yield* auth.at(other).startLogin;
		assert.equal(otherLogin.options.rpId, "other.test");
		yield* fails(
			auth.at(other).finishLogin(otherLogin.id, sign(first, otherLogin.options.challenge, other)),
			"authentication_invalid",
		);
		const crossed = yield* auth.at(other).startLogin;
		yield* fails(
			auth.at(other).finishLogin(crossed.id, sign(first, crossed.options.challenge, primary)),
			"authentication_invalid",
		);
		// An action proof signed on another origin for this passkey's RP ID is refused as well.
		const action = yield* auth.at(other).startPasskeyCodeAssertion({}, session.id);
		assert.equal(action.options.rpId, "other.test");
		yield* fails(
			auth.createPasskeyCode({}, { id: action.id, response: sign(first, action.options.challenge, other) }, session.id),
			"authentication_invalid",
		);
		// Registration started on one origin cannot be completed with a credential for another RP ID.
		const registration = yield* auth.at(other).startPasskeyRegistration("Other key", session.id);
		assert.equal(registration.options.rp.id, "other.test");
	} else if (scenario === "code") {
		// A fresh proof is required, and it must name exactly the requested target origin.
		const wrongAction = yield* auth.startPasskeyDeleteAssertion({ id: first.id }, session.id);
		yield* fails(
			auth.createPasskeyCode(
				{},
				{ id: wrongAction.id, response: sign(first, wrongAction.options.challenge, primary) },
				session.id,
			),
			"challenge_invalid",
		);
		yield* fails(
			auth.createPasskeyCode({}, yield* codeProof({ origin: added.expectedOrigin }), session.id),
			"challenge_invalid",
		);
		yield* fails(
			auth.createPasskeyCode({ origin: added.expectedOrigin }, yield* codeProof({}), session.id),
			"challenge_invalid",
		);
		for (const origin of ["https://new.test/path", "ftp://new.test", "https://user@new.test", "not an origin"])
			yield* fails(auth.createPasskeyCode({ origin }, yield* codeProof({ origin }), session.id), "invalid_request");
		const replayed = yield* codeProof({});
		const issued = yield* auth.createPasskeyCode({}, replayed, session.id);
		assert.match(issued.code, /^[A-F0-9]{16}$/);
		assert.equal(issued.origin, null);
		yield* fails(auth.createPasskeyCode({}, replayed, session.id), "challenge_invalid");
		// Only a digest is stored, and no event or log carries the code.
		const stored = yield* sql`SELECT hash FROM passkey_codes`;
		assert.equal(stored.length, 1);
		assert.notEqual(stored[0]?.hash, issued.code);
		assert.ok(!JSON.stringify(yield* sql`SELECT * FROM events`).includes(issued.code));
		assert.ok(!output.some((line) => line.includes(issued.code)));
		// A newer code invalidates the previous one.
		const newer = yield* create();
		yield* fails(auth.startPasskeyCodeRedemption(issued.code, primary.expectedOrigin), "passkey_code_invalid");
		// Origins that are neither allowed nor bound are refused before the code is examined and spend nothing.
		for (const origin of [undefined, "https://evil.test", "https://sub.comms.test"])
			for (const _ of [1, 2, 3, 4, 5])
				yield* fails(auth.startPasskeyCodeRedemption("0000000000000000", origin), "origin_invalid");
		assert.deepEqual(yield* sql`SELECT failures, locked_until FROM passkey_codes`, [{ failures: 1, locked_until: 0 }]);
		// The third wrong code locks redemption for a minute without deleting the code; even the right code waits.
		yield* fails(auth.startPasskeyCodeRedemption("0000000000000000", primary.expectedOrigin), "passkey_code_invalid");
		yield* fails(auth.startPasskeyCodeRedemption("0000000000000000", primary.expectedOrigin), "passkey_code_invalid");
		const lockedFor = (row: unknown) =>
			Effect.map(Clock.currentTimeMillis, (now) =>
				typeof row === "object" && row !== null && "locked_until" in row ? Number(row.locked_until) - now : -1,
			);
		const locked = yield* sql`SELECT failures, locked_until FROM passkey_codes`;
		assert.equal(locked.length, 1);
		const firstLock = yield* lockedFor(locked[0]);
		assert.ok(firstLock > 55_000 && firstLock <= 60_000, String(firstLock));
		yield* fails(auth.startPasskeyCodeRedemption(newer.code, primary.expectedOrigin), "passkey_code_locked");
		// A further wrong code after the lockout doubles it.
		yield* sql`UPDATE passkey_codes SET locked_until=0`;
		yield* fails(auth.startPasskeyCodeRedemption("0000000000000000", primary.expectedOrigin), "passkey_code_invalid");
		const doubled = yield* lockedFor((yield* sql`SELECT locked_until FROM passkey_codes`)[0]);
		assert.ok(doubled > 115_000 && doubled <= 120_000, String(doubled));
		// Once the lockout ends, the right code still works.
		yield* sql`UPDATE passkey_codes SET locked_until=0`;
		assert.ok((yield* auth.startPasskeyCodeRedemption(newer.code, primary.expectedOrigin)).id);
		// Expiry.
		const expiring = yield* create();
		yield* sql`UPDATE passkey_codes SET expires_at=1`;
		yield* fails(auth.startPasskeyCodeRedemption(expiring.code, primary.expectedOrigin), "passkey_code_invalid");
		// Revocation, including a ceremony already started with the code.
		const revoked = yield* create();
		const pending = yield* auth.startPasskeyCodeRedemption(revoked.code, primary.expectedOrigin);
		assert.deepEqual(yield* auth.revokePasskeyCode(session.id), { revoked: true });
		yield* fails(
			auth.finishPasskeyCodeRedemption(
				pending.id,
				second.registration(pending.options.challenge),
				primary.expectedOrigin,
			),
			"challenge_invalid",
		);
		yield* fails(auth.startPasskeyCodeRedemption(revoked.code, primary.expectedOrigin), "passkey_code_invalid");
		// An unbound code redeems on any allowed origin, binds the passkey to that RP ID, signs in, and is single-use.
		const usable = yield* create();
		const redeemed = yield* redeem(usable.code, second, other);
		assert.ok((yield* auth.authenticateSession(redeemed.token)).id);
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys WHERE id=${second.id}`, [{ rp_id: "other.test" }]);
		yield* fails(auth.startPasskeyCodeRedemption(usable.code, other.expectedOrigin), "passkey_code_invalid");
		yield* login(second, other);
		yield* fails(login(second, primary), "authentication_invalid");
		const types = (yield* sql`SELECT type FROM events WHERE type LIKE 'auth.passkey_code%' ORDER BY seq`).map(
			(row) => row.type,
		);
		for (const type of ["created", "refused", "revoked", "redeemed"])
			assert.ok(types.includes(`auth.passkey_code_${type}`), `missing ${type} event`);
	} else if (scenario === "bound-origin") {
		const issued = yield* create({ origin: added.expectedOrigin });
		assert.equal(issued.origin, added.expectedOrigin);
		// A pending origin grants nothing.
		yield* fails(auth.relyingParty(added.expectedOrigin), "origin_invalid");
		const listed = yield* auth.listOrigins(session.id);
		assert.deepEqual(
			listed.items.map((item) => [item.origin, item.source, item.status, item.removable]),
			[
				["https://comms.test", "config", "active", false],
				["https://other.test", "config", "active", false],
				["https://new.test", "code", "pending", false],
			],
		);
		// Redeeming from another origin, even an allowed one, is refused without spending an attempt.
		yield* fails(auth.startPasskeyCodeRedemption(issued.code, primary.expectedOrigin), "origin_invalid");
		yield* fails(auth.startPasskeyCodeRedemption(issued.code, undefined), "origin_invalid");
		assert.deepEqual(yield* sql`SELECT failures FROM passkey_codes`, [{ failures: 0 }]);
		// Redemption from the bound origin activates it and adds a passkey for its hostname in one transaction.
		// A lowercase transcription of the code is accepted.
		const redeemed = yield* redeem(issued.code.toLowerCase(), second, added);
		assert.ok(redeemed.token);
		assert.deepEqual(yield* auth.relyingParty(added.expectedOrigin), added);
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys WHERE id=${second.id}`, [{ rp_id: "new.test" }]);
		yield* login(second, added);
		// Runtime origins survive restart.
		auth = yield* start();
		assert.deepEqual(yield* auth.relyingParty(added.expectedOrigin), added);
		yield* login(second, added);
		assert.ok((yield* sql`SELECT id FROM sessions WHERE origin=${added.expectedOrigin}`).length >= 2);
		// Removal: never a configured origin or the request's own origin, never while passkeys are bound to it.
		const removeProof = (origin: string, party: RelyingParty, device: ReturnType<typeof authenticator>) =>
			Effect.gen(function* () {
				const challenge = yield* auth.at(party).startOriginRemoveAssertion({ origin }, session.id);
				return { id: challenge.id, response: sign(device, challenge.options.challenge, party) };
			});
		yield* fails(
			auth
				.at(added)
				.removeOrigin(
					{ origin: added.expectedOrigin },
					yield* removeProof(added.expectedOrigin, added, second),
					session.id,
				),
			"origin_protected",
		);
		yield* fails(
			auth
				.at(primary)
				.removeOrigin(
					{ origin: other.expectedOrigin },
					yield* removeProof(other.expectedOrigin, primary, first),
					session.id,
				),
			"origin_protected",
		);
		yield* fails(
			auth
				.at(primary)
				.removeOrigin(
					{ origin: added.expectedOrigin },
					yield* removeProof(added.expectedOrigin, primary, first),
					session.id,
				),
			"origin_has_passkeys",
		);
		yield* fails(
			auth
				.at(primary)
				.removeOrigin(
					{ origin: "https://missing.test" },
					yield* removeProof("https://missing.test", primary, first),
					session.id,
				),
			"origin_not_found",
		);
		const deletion = yield* auth.startPasskeyDeleteAssertion({ id: second.id }, session.id);
		yield* auth.deletePasskey(
			{ id: second.id },
			{ id: deletion.id, response: sign(first, deletion.options.challenge, primary) },
			session.id,
		);
		assert.deepEqual(
			yield* auth
				.at(primary)
				.removeOrigin(
					{ origin: added.expectedOrigin },
					yield* removeProof(added.expectedOrigin, primary, first),
					session.id,
				),
			{ removed: added.expectedOrigin },
		);
		yield* fails(auth.relyingParty(added.expectedOrigin), "origin_invalid");
		// Sessions issued on the removed origin end with it; the primary origin's session does not.
		yield* fails(auth.authenticateSession(redeemed.token), "session_invalid");
		assert.equal((yield* sql`SELECT id FROM sessions WHERE origin=${added.expectedOrigin}`).length, 0);
		assert.ok((yield* auth.authenticateSession(session.token)).id);
	} else if (scenario === "zero-passkeys") {
		const issued = yield* create();
		yield* sql`DELETE FROM passkeys`;
		yield* fails(auth.startPasskeyCodeRedemption(issued.code, primary.expectedOrigin), "setup_required");
		assert.deepEqual(yield* sql`SELECT failures FROM passkey_codes`, [{ failures: 0 }]);
	} else if (scenario === "backfill") {
		// Rebuild the v19 store this board had before step 20, holding the passkey created above.
		yield* sql`DROP TABLE auth_origins`;
		yield* sql`DROP TABLE passkey_codes`;
		yield* sql`ALTER TABLE passkeys DROP COLUMN rp_id`;
		yield* sql`ALTER TABLE sessions DROP COLUMN origin`;
		yield* sql`DELETE FROM boot_migrations WHERE migration_id=20`;
		yield* sql`PRAGMA user_version=19`;
		yield* initializeBootSchema;
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys`, [{ rp_id: null }]);
		// Upgrading while also misconfiguring the primary RP ID refuses the passkey but does not relabel it.
		const mistaken: RelyingParty = { rpId: "login.comms.test", expectedOrigin: "https://login.comms.test" };
		auth = yield* start(mistaken);
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys`, [{ rp_id: null }]);
		const refused = yield* auth.at(mistaken).startLogin;
		yield* fails(
			auth
				.at(mistaken)
				.finishLogin(refused.id, first.assertion(refused.options.challenge, 90, mistaken.expectedOrigin, primary.rpId)),
			"authentication_invalid",
		);
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys`, [{ rp_id: null }]);
		// Restoring the configuration recovers; the first proven signature stamps the primary RP ID.
		auth = yield* start();
		yield* login(first, primary);
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys`, [{ rp_id: "comms.test" }]);
		yield* fails(login(first, other), "authentication_invalid");
		// PUBLIC_ORIGINS names no RP ID for a passkey without one recorded, so boot refuses to start with it.
		yield* sql`UPDATE passkeys SET rp_id=NULL`;
		yield* fails(start(primary, true), "auth_configuration_invalid");
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys`, [{ rp_id: null }]);
		// Reverting to the single-origin config starts, and a sign-in there records the RP ID.
		auth = yield* start();
		yield* login(first, primary);
		// With every passkey recorded, PUBLIC_ORIGINS starts and the passkey still signs in.
		auth = yield* start(primary, true);
		yield* login(first, primary);
	} else if (scenario === "shared-rp") {
		// A runtime origin on the primary's parent domain shares its RP ID with the configured primary origin.
		const issued = yield* create({ origin: primary.expectedOrigin });
		const redeemed = yield* redeem(issued.code, second, primary);
		assert.deepEqual(yield* sql`SELECT DISTINCT rp_id FROM passkeys`, [{ rp_id: "comms.test" }]);
		// Its passkeys stay usable through the primary origin, so it is removable despite having passkeys.
		const challenge = yield* auth.at(board).startOriginRemoveAssertion({ origin: primary.expectedOrigin }, session.id);
		assert.deepEqual(
			yield* auth
				.at(board)
				.removeOrigin(
					{ origin: primary.expectedOrigin },
					{ id: challenge.id, response: sign(first, challenge.options.challenge, board) },
					session.id,
				),
			{ removed: primary.expectedOrigin },
		);
		yield* fails(auth.relyingParty(primary.expectedOrigin), "origin_invalid");
		yield* fails(auth.authenticateSession(redeemed.token), "session_invalid");
		yield* login(second, board);
	} else if (scenario === "configured-passkeys") {
		const issued = yield* create({ origin: added.expectedOrigin });
		yield* redeem(issued.code, second, added);
		// An unstamped passkey counts as the primary RP ID's.
		yield* sql`UPDATE passkeys SET rp_id=NULL WHERE id=${first.id}`;
		assert.deepEqual(
			(yield* auth.listPasskeys(session.id)).items.map((key) => [key.id, key.can_delete]),
			[
				[first.id, false],
				[second.id, true],
			],
		);
		const deleteProof = (id: string, device: ReturnType<typeof authenticator>, party: RelyingParty) =>
			Effect.gen(function* () {
				const challenge = yield* auth.at(party).startPasskeyDeleteAssertion({ id }, session.id);
				return { id: challenge.id, response: sign(device, challenge.options.challenge, party) };
			});
		// The primary's last passkey is kept while another domain still has one. The proof comes from the other
		// domain's passkey, so the primary passkey stays unstamped for this check.
		yield* fails(
			auth.deletePasskey({ id: first.id }, yield* deleteProof(first.id, second, added), session.id),
			"origin_last_passkey",
		);
		assert.deepEqual(yield* sql`SELECT rp_id FROM passkeys WHERE id=${first.id}`, [{ rp_id: null }]);
		// A runtime domain's passkey stays deletable while the primary keeps one.
		yield* auth.deletePasskey({ id: second.id }, yield* deleteProof(second.id, first, primary), session.id);
		assert.deepEqual(
			(yield* auth.listPasskeys(session.id)).items.map((key) => key.id),
			[first.id],
		);
	} else throw new Error("Unknown scenario");
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("passkey code passed"));
