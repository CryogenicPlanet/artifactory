import { layer as durableEventsLayer } from "../../src/events.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Context, Effect, FileSystem, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { authenticator } from "./authenticator.ts";

const editLockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const fs = yield* FileSystem.FileSystem;
	const database = process.argv[2];
	if (!database) throw new Error("Missing test database");
	yield* initializeBootSchema;
	const output: string[] = [];
	const capturedConsole: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const restart = () =>
		Layer.build(
			layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
				Layer.provide(Layer.mergeAll(eventsLayer(Effect.void), editLockLayer)),
			),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, capturedConsole),
		);
	const boot = yield* restart();
	const code = () => {
		const value = output.at(-1)?.split("code ")[1];
		assert.ok(value);
		return value;
	};
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, expected?: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result));
				if (expected)
					assert.ok(
						result.failure &&
							typeof result.failure === "object" &&
							"code" in result.failure &&
							result.failure.code === expected,
					);
			}),
		);
	const device = authenticator();
	const scenario = process.argv[3];
	if (scenario === "resume") {
		const token = yield* fs.readFileString(`${database}.session`);
		assert.equal(output.length, 0);
		assert.ok((yield* boot.authenticateSession(token)).id);
		yield* boot.logout(token);
		yield* fails(boot.authenticateSession(token), "session_invalid");
	} else if (scenario === "setup") {
		const firstCode = code();
		const pending = yield* boot.startSetup(firstCode);
		for (let n = 0; n < 3; n++) yield* fails(boot.startSetup("wrong"), "setup_code_invalid");
		assert.notEqual(code(), firstCode);
		yield* fails(boot.finishSetup(pending.id, device.registration(pending.options.challenge)), "challenge_invalid");
		const another = yield* boot.startSetup(code());
		const previous = code();
		const again = yield* restart();
		assert.notEqual(code(), previous);
		yield* fails(again.startSetup(previous), "setup_code_invalid");
		yield* fails(again.finishSetup(another.id, device.registration(another.options.challenge)), "challenge_invalid");
		const a = yield* again.startSetup(code());
		const b = yield* again.startSetup(code());
		const other = authenticator();
		const results = yield* Effect.all(
			[
				again.finishSetup(a.id, device.registration(a.options.challenge)).pipe(Effect.result),
				again.finishSetup(b.id, other.registration(b.options.challenge)).pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(results.filter(Result.isSuccess).length, 1);
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
		const priorCode = code();
		yield* sql`DELETE FROM passkeys`;
		yield* fails(again.startSetup(priorCode), "setup_code_invalid");
		assert.equal(yield* again.setupOpen, true);
		assert.notEqual(code(), priorCode);
		const recovery = yield* again.startSetup(code());
		yield* again.finishSetup(recovery.id, device.registration(recovery.options.challenge));
		assert.equal(yield* again.setupOpen, false);
		yield* fails(again.startSetup(code()), "setup_closed");
	} else {
		const registration = yield* boot.startSetup(code());
		if (scenario === "registration-validation") {
			yield* fails(
				boot.finishSetup(registration.id, device.registration(registration.options.challenge, "https://evil.test")),
				"registration_invalid",
			);
			yield* fails(
				boot.finishSetup(registration.id, device.registration(registration.options.challenge, undefined, "evil.test")),
				"registration_invalid",
			);
			yield* fails(
				boot.finishSetup(
					registration.id,
					device.registration(registration.options.challenge, undefined, undefined, false),
				),
				"registration_invalid",
			);
			yield* sql`UPDATE auth_challenges SET expires_at = 0 WHERE id = ${registration.id}`;
			yield* fails(
				boot.finishSetup(registration.id, device.registration(registration.options.challenge)),
				"challenge_invalid",
			);
			assert.equal((yield* sql`SELECT id FROM passkeys`).length, 0);
		} else {
			yield* boot.finishSetup(registration.id, device.registration(registration.options.challenge));
			const login = yield* boot.startLogin;
			if (scenario === "login-validation") {
				yield* fails(
					boot.finishLogin(login.id, device.assertion(login.options.challenge, 1, "https://evil.test")),
					"authentication_invalid",
				);
				yield* fails(
					boot.finishLogin(login.id, device.assertion(login.options.challenge, 1, undefined, "evil.test")),
					"authentication_invalid",
				);
				yield* fails(
					boot.finishLogin(login.id, device.assertion(login.options.challenge, 1, undefined, undefined, false)),
					"authentication_invalid",
				);
				const tampered = device.assertion(login.options.challenge);
				tampered.response.signature = Buffer.alloc(64).toString("base64url");
				yield* fails(boot.finishLogin(login.id, tampered), "authentication_invalid");
				yield* sql`UPDATE auth_challenges SET expires_at = 0 WHERE id = ${login.id}`;
				yield* fails(boot.finishLogin(login.id, device.assertion(login.options.challenge)), "challenge_invalid");
				assert.equal((yield* sql`SELECT id FROM sessions`).length, 0);
			} else {
				const response = device.assertion(login.options.challenge);
				yield* sql`CREATE TRIGGER refuse_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'session disk failure'); END`;
				yield* fails(boot.finishLogin(login.id, response));
				assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id = ${login.id}`).length, 1);
				assert.deepEqual(yield* sql`SELECT counter FROM passkeys WHERE id = ${device.id}`, [{ counter: 0 }]);
				yield* sql`DROP TRIGGER refuse_session`;
				const session = yield* boot.finishLogin(login.id, response);
				assert.equal(Buffer.from(session.token, "base64url").length, 32);
				yield* fails(boot.finishLogin(login.id, response), "challenge_invalid");
				const logged = yield* boot.authenticateSession(session.token);
				assert.equal(logged.id, session.id);
				const rows = yield* sql`SELECT * FROM sessions`;
				assert.ok(!Object.values(rows[0] ?? {}).includes(session.token));
				assert.equal(
					Object.keys(rows[0] ?? {})
						.sort()
						.join(","),
					"created_at,expires_at,hash,id,last_seen_at",
				);
				const again = yield* restart();
				assert.equal((yield* again.authenticateSession(session.token)).id, session.id);
				const replayCounter = yield* again.startLogin;
				yield* fails(
					again.finishLogin(replayCounter.id, device.assertion(replayCounter.options.challenge, 1)),
					"authentication_invalid",
				);
				const challenge = yield* again.startLogin;
				const concurrent = device.assertion(challenge.options.challenge, 2);
				const results = yield* Effect.all(
					[
						again.finishLogin(challenge.id, concurrent).pipe(Effect.result),
						again.finishLogin(challenge.id, concurrent).pipe(Effect.result),
					],
					{ concurrency: "unbounded" },
				);
				assert.equal(results.filter(Result.isSuccess).length, 1);
				yield* again.logout(session.token);
				yield* fails(again.authenticateSession(session.token), "session_invalid");
				const finalChallenge = yield* again.startLogin;
				const expired = yield* again.finishLogin(
					finalChallenge.id,
					device.assertion(finalChallenge.options.challenge, 3),
				);
				yield* sql`UPDATE sessions SET expires_at = 0 WHERE id = ${expired.id}`;
				yield* fails(again.authenticateSession(expired.token), "session_invalid");
				const restartChallenge = yield* again.startLogin;
				const persisted = yield* again.finishLogin(
					restartChallenge.id,
					device.assertion(restartChallenge.options.challenge, 4),
				);
				yield* fs.writeFileString(`${database}.session`, persisted.token, { mode: 0o600 });
			}
		}
	}
});

const filename = process.argv[2];
if (!filename) throw new Error("Missing test database");
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("auth scenario passed"));
