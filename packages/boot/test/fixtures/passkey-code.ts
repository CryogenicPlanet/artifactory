import { layer as durableEventsLayer } from "../../src/events.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Context, Effect, Layer, Result } from "effect";
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
	const start = (configured: RelyingParty = primary) =>
		Layer.build(
			authLayer({ ...configured, additionalOrigins: [other] }).pipe(
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
	let auth = yield* start();
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
	yield* auth.finishSetup(setup.id, first.registration(setup.options.challenge));
	const login = (device: ReturnType<typeof authenticator>, party: RelyingParty) =>
		Effect.gen(function* () {
			const challenge = yield* auth.at(party).startLogin;
			return yield* auth.at(party).finishLogin(challenge.id, sign(device, challenge.options.challenge, party));
		});
	const session = yield* login(first, primary);
	const codeProof = (params: { readonly origin?: string }, party = primary, device = first) =>
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
		// Wrong guesses are limited: the third failure discards the code.
		yield* fails(auth.startPasskeyCodeRedemption("0000000000000000", primary.expectedOrigin), "passkey_code_invalid");
		yield* fails(auth.startPasskeyCodeRedemption("0000000000000000", primary.expectedOrigin), "passkey_code_invalid");
		yield* fails(auth.startPasskeyCodeRedemption(newer.code, primary.expectedOrigin), "passkey_code_invalid");
		assert.equal((yield* sql`SELECT id FROM passkey_codes`).length, 0);
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
		// Redeeming from another origin, even an allowed one, fails and consumes an attempt.
		yield* fails(auth.startPasskeyCodeRedemption(issued.code, primary.expectedOrigin), "origin_invalid");
		yield* fails(auth.startPasskeyCodeRedemption(issued.code, undefined), "origin_invalid");
		assert.deepEqual(yield* sql`SELECT failures FROM passkey_codes`, [{ failures: 2 }]);
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
	} else throw new Error("Unknown scenario");
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("passkey code passed"));
