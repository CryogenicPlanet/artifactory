/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Context, Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditLock, layer as lockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { authenticator } from "./authenticator.ts";

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
	const dependencies = Layer.mergeAll(lockLayer, eventsLayer);
	const restart = () =>
		Layer.build(
			authLayer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(Layer.provide(dependencies)),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
	const auth = yield* restart();
	const lock = Context.get(yield* Layer.build(lockLayer), EditLock);
	const device = authenticator();
	const code = output.at(-1)?.split("code ")[1];
	assert.ok(code);
	const setup = yield* auth.startSetup(code);
	yield* auth.finishSetup(setup.id, device.registration(setup.options.challenge));
	const login = yield* auth.startLogin;
	const session = yield* auth.finishLogin(login.id, device.assertion(login.options.challenge, 1));
	let counter = 1;
	const proofFor = (id: string) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startLockBreakAssertion({ id });
			return { id: challenge.id, response: device.assertion(challenge.options.challenge, ++counter) };
		});
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, code?: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result));
				if (code)
					assert.ok(
						result.failure &&
							typeof result.failure === "object" &&
							"code" in result.failure &&
							result.failure.code === code,
					);
			}),
		);
	const acquired = (yield* lock.acquire("holder", "codex")).value;
	const owner = { id: acquired.id, family: acquired.holder_family };
	yield* lock.stage(owner, "app/change.ts", new TextEncoder().encode("pending"));
	if (scenario === "transaction") {
		const proof = yield* proofFor(acquired.id);
		yield* sql`CREATE TRIGGER refuse_break BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='lock.broken' BEGIN SELECT RAISE(ABORT, 'event disk failure'); END`;
		yield* fails(auth.breakLock({ id: acquired.id }, proof, session.id));
		assert.equal((yield* lock.inspect).value?.id, acquired.id);
		assert.equal((yield* sql`SELECT * FROM staging`).length, 1);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 1 }]);
		yield* sql`DROP TRIGGER refuse_break`;
		// Recreate the service to prove the same persisted challenge survives a failed transaction.
		const restarted = yield* restart();
		const attempts = yield* Effect.all(
			[
				restarted.breakLock({ id: acquired.id }, proof, session.id).pipe(Effect.result),
				restarted.breakLock({ id: acquired.id }, proof, session.id).pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(attempts.filter(Result.isSuccess).length, 1);
		assert.equal((yield* lock.inspect).value, null);
		assert.equal((yield* sql`SELECT * FROM staging`).length, 0);
		assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='lock.broken'`).length, 1);
		yield* fails(restarted.breakLock({ id: acquired.id }, proof, session.id), "challenge_invalid");
	} else if (scenario === "fence") {
		const proof = yield* proofFor(acquired.id);
		yield* lock.release(owner);
		const replacement = (yield* lock.acquire("other", "claude")).value;
		yield* fails(auth.breakLock({ id: acquired.id }, proof, session.id), "stale_lock");
		assert.equal((yield* lock.inspect).value?.id, replacement.id);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='lock.broken'`).length, 0);
		const fresh = yield* proofFor(replacement.id);
		yield* lock.pin({ id: replacement.id, family: "other" });
		const result = yield* auth.breakLock({ id: replacement.id }, fresh, session.id);
		assert.equal(result?.pending_release, "broken");
		assert.equal(result?.cutover_in_flight, 1);
		yield* fails(lock.acquire("competitor", "codex"), "cutover_in_flight");
		const finished = yield* lock.finish({ id: replacement.id, family: "other" }, { succeeded: false });
		assert.equal(finished.value, null);
		assert.ok((yield* lock.acquire("competitor", "codex")).value.id);
	} else {
		const proof = yield* proofFor(acquired.id);
		const challengeRows = yield* sql`SELECT challenge FROM auth_challenges WHERE id=${proof.id}`;
		const challenge = challengeRows[0]?.challenge;
		assert.equal(typeof challenge, "string");
		if (typeof challenge !== "string") throw new Error("Missing challenge");
		for (const response of [
			device.assertion(challenge, counter, "https://evil.test"),
			device.assertion(challenge, counter, undefined, "evil.test"),
			device.assertion(challenge, counter, undefined, undefined, false),
		])
			yield* fails(
				auth.breakLock({ id: acquired.id }, { id: proof.id, response }, session.id),
				"authentication_invalid",
			);
		// Simulates session expiry during verification, immediately after valid proof consumption.
		yield* sql`CREATE TRIGGER expire_session AFTER DELETE ON auth_challenges WHEN OLD.ceremony='lock.break' BEGIN UPDATE sessions SET expires_at=0; END`;
		yield* fails(auth.breakLock({ id: acquired.id }, proof, session.id), "session_invalid");
		assert.equal((yield* lock.inspect).value?.id, acquired.id);
		assert.equal((yield* sql`SELECT * FROM staging`).length, 1);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='lock.broken'`).length, 0);
	}
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("signed lock break passed"));
