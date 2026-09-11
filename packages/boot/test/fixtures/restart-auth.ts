/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Context, Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { authenticator } from "./authenticator.ts";
import { fails } from "./token-session.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
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
	const dependencies = lockLayer.pipe(Layer.provideMerge(eventsLayer(Effect.void)));
	const recreate = () =>
		Layer.build(
			authLayer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(Layer.provide(dependencies)),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
	const auth = yield* recreate();
	const device = authenticator();
	const code = output.at(-1)?.split("code ")[1];
	assert.ok(code);
	const setup = yield* auth.startSetup(code);
	yield* auth.finishSetup(setup.id, device.registration(setup.options.challenge));
	let counter = 0;
	const login = () =>
		Effect.gen(function* () {
			const challenge = yield* auth.startLogin;
			return yield* auth.finishLogin(challenge.id, device.assertion(challenge.options.challenge, ++counter));
		});
	const session = yield* login();
	const proofFor = () =>
		Effect.gen(function* () {
			const challenge = yield* auth.startRestartAssertion(session.id);
			return {
				id: challenge.id,
				response: device.assertion(challenge.options.challenge, ++counter),
				challenge: challenge.options.challenge,
			};
		});
	if (scenario === "binding") {
		const other = yield* login();
		const proof = yield* proofFor();
		yield* fails(auth.authorizeRestart(proof, other.id), "challenge_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		const wrongAction = yield* auth.startLockBreakAssertion({ id: "00000000-0000-4000-8000-000000000001" });
		yield* fails(
			auth.authorizeRestart(
				{ id: wrongAction.id, response: device.assertion(wrongAction.options.challenge, ++counter) },
				session.id,
			),
			"challenge_invalid",
		);
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${proof.id}`;
		yield* fails(auth.authorizeRestart(proof, session.id), "challenge_invalid");
		const fresh = yield* proofFor();
		yield* auth.authorizeRestart(fresh, session.id);
		yield* fails(auth.authorizeRestart(fresh, session.id), "challenge_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${fresh.id}`).length, 0);
	} else if (scenario === "verification") {
		const proof = yield* proofFor();
		const before = yield* sql`SELECT counter FROM passkeys`;
		for (const response of [
			device.assertion(proof.challenge, counter, "https://evil.test"),
			device.assertion(proof.challenge, counter, undefined, "evil.test"),
			device.assertion(proof.challenge, counter, undefined, undefined, false),
			{ ...proof.response, response: { ...proof.response.response, signature: "AAAA" } },
		]) {
			yield* fails(auth.authorizeRestart({ id: proof.id, response }, session.id), "authentication_invalid");
			assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, before);
			assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		}
		yield* auth.authorizeRestart(proof, session.id);
	} else if (scenario === "session-expiry" || scenario === "session-revocation") {
		const proof = yield* proofFor();
		// The verifier has updated the counter and consumed the proof before this invalidates the session.
		if (scenario === "session-expiry")
			yield* sql`CREATE TRIGGER expire_session AFTER DELETE ON auth_challenges WHEN OLD.ceremony='boot.restart' BEGIN UPDATE sessions SET expires_at=0; END`;
		else
			yield* sql`CREATE TRIGGER revoke_session AFTER DELETE ON auth_challenges WHEN OLD.ceremony='boot.restart' BEGIN DELETE FROM sessions; END`;
		yield* fails(auth.authorizeRestart(proof, session.id), "session_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter }]);
		yield* fails(auth.authenticateSession(session.token), "session_invalid");
	} else if (scenario === "transaction") {
		const proof = yield* proofFor();
		const before = yield* sql`SELECT counter FROM passkeys`;
		yield* sql`CREATE TRIGGER refuse_restart AFTER DELETE ON auth_challenges WHEN OLD.ceremony='boot.restart' BEGIN SELECT RAISE(ABORT, 'restart proof storage failure'); END`;
		yield* fails(auth.authorizeRestart(proof, session.id));
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, before);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		yield* sql`DROP TRIGGER refuse_restart`;
		const restarted = yield* recreate();
		yield* restarted.authorizeRestart(proof, session.id);
		yield* fails(restarted.authorizeRestart(proof, session.id), "challenge_invalid");
	} else if (scenario === "concurrency") {
		const proof = yield* proofFor();
		const attempts = yield* Effect.all(
			[
				auth.authorizeRestart(proof, session.id).pipe(Effect.result),
				auth.authorizeRestart(proof, session.id).pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(attempts.filter(Result.isSuccess).length, 1);
		assert.equal(attempts.filter(Result.isFailure).length, 1);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter }]);
	} else throw new Error(`Unknown scenario: ${scenario}`);
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("signed restart authorization passed"));
