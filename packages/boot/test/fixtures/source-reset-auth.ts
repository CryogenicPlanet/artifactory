/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Effect, Layer, Result, Schema } from "effect";
import { SourceResetParams } from "../../src/source-reset-schema.ts";
import { fails, tokenSession } from "./token-session.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const { auth, sql, device } = yield* tokenSession;
	const login = yield* auth.startLogin;
	const session = yield* auth.finishLogin(login.id, device.assertion(login.options.challenge, 2));
	const seed = "a".repeat(64);
	let counter = 2;
	const proofFor = (digest = seed, owner = session.id, origin?: string, uv = true) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startSourceResetAssertion(digest, owner);
			return {
				id: challenge.id,
				response: device.assertion(challenge.options.challenge, ++counter, origin, undefined, uv),
			};
		});
	const authorize = (proof: Effect.Success<ReturnType<typeof proofFor>>, digest = seed, owner = session.id) =>
		auth.authorizeSourceReset(digest, proof, owner);
	if (scenario === "binding") {
		assert.deepEqual(yield* Schema.decodeEffect(SourceResetParams)({}), {});
		for (const input of [{ seed }, { path: "/private/source" }, { withDb: true }, []])
			yield* fails(Schema.decodeUnknownEffect(SourceResetParams)(input));
		const proof = yield* proofFor();
		for (const invalid of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
			yield* fails(proofFor(invalid), "invalid_request");
			yield* fails(authorize(proof, invalid), "invalid_request");
		}
		yield* fails(authorize(proof, "b".repeat(64)), "challenge_invalid");
		const otherLogin = yield* auth.startLogin;
		const other = yield* auth.finishLogin(otherLogin.id, device.assertion(otherLogin.options.challenge, ++counter));
		const bound = yield* proofFor();
		yield* fails(authorize(bound, seed, other.id), "challenge_invalid");
		const unrelated = yield* auth.startDatabaseRestoreAssertion(
			{ backup: "00000000-0000-4000-8000-000000000001" },
			session.id,
		);
		yield* fails(
			authorize({ id: unrelated.id, response: device.assertion(unrelated.options.challenge, ++counter) }),
			"challenge_invalid",
		);
		yield* authorize(bound);
	} else if (scenario === "verifier") {
		yield* fails(authorize(yield* proofFor(seed, session.id, "https://evil.test")), "authentication_invalid");
		yield* fails(authorize(yield* proofFor(seed, session.id, undefined, false)), "authentication_invalid");
		const expired = yield* proofFor();
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${expired.id}`;
		yield* fails(authorize(expired), "challenge_invalid");
		const tampered = yield* proofFor();
		yield* fails(
			authorize({
				...tampered,
				response: { ...tampered.response, response: { ...tampered.response.response, signature: "AAAA" } },
			}),
			"authentication_invalid",
		);
		const loggedOut = yield* proofFor();
		yield* auth.logout(session.token);
		yield* fails(authorize(loggedOut), "session_invalid");
	} else if (scenario === "replay") {
		const proof = yield* proofFor();
		const results = yield* Effect.all([authorize(proof).pipe(Effect.result), authorize(proof).pipe(Effect.result)], {
			concurrency: "unbounded",
		});
		assert.equal(results.filter(Result.isSuccess).length, 1);
		yield* fails(authorize(proof), "challenge_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 0);
	} else if (scenario === "transaction") {
		const proof = yield* proofFor();
		yield* sql`CREATE TRIGGER refuse_consumption BEFORE DELETE ON auth_challenges BEGIN SELECT RAISE(ABORT, 'disk failure'); END`;
		yield* fails(authorize(proof));
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys WHERE id=${device.id}`, [{ counter: 2 }]);
		yield* sql`DROP TRIGGER refuse_consumption`;
		yield* authorize(proof);
		yield* fails(authorize(proof), "challenge_invalid");
	} else if (scenario === "late-session") {
		const proof = yield* proofFor();
		yield* sql`CREATE TRIGGER expire_session AFTER UPDATE OF counter ON passkeys BEGIN UPDATE sessions SET expires_at=0; END`;
		yield* fails(authorize(proof), "session_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys WHERE id=${device.id}`, [{ counter: 3 }]);
	} else throw new Error("Unknown scenario");
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("source reset auth passed"));
