import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { remoteOwnerInventory } from "../../src/remote-owner-inventory.ts";
import { configuration } from "./remote-keeper-config.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.argv[2] ?? "");
	const config = yield* configuration;
	let phase = "opening runtime";
	const exercise = Effect.gen(function* () {
		const runtime = yield* remoteRuntime(config, root);
		phase = "boot query";
		assert.equal((yield* runtime.bootSql<{ value: number }>`SELECT 1 AS value`)[0]?.value, 1);
		const idQuery =
			config.appConnection.engine === "pg" ? "SELECT pg_backend_pid() AS id" : "SELECT CONNECTION_ID() AS id";
		for (const rejected of [false, true]) {
			let connectionId = 0;
			phase = rejected ? "failed operation cleanup" : "borrowed operation cleanup";
			const operation = yield* runtime
				.withStore(
					config.app,
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const borrowed = yield* sql.reserve;
						const rows = yield* borrowed
							.execute(idQuery, [], undefined)
							.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Number })))));
						connectionId = rows[0]?.id ?? 0;
						assert(connectionId > 0);
						if (rejected) return yield* Effect.fail("deliberate fixture failure");
						return connectionId;
					}),
				)
				.pipe(Effect.result);
			assert.equal(operation._tag, rejected ? "Failure" : "Success");
			const active =
				config.appConnection.engine === "pg"
					? yield* runtime.bootSql<{ id: number }>`SELECT pid AS id FROM pg_stat_activity WHERE pid = ${connectionId}`
					: yield* runtime.bootSql<{
							id: number;
						}>`SELECT ID AS id FROM information_schema.PROCESSLIST WHERE ID = ${connectionId}`;
			assert.equal(active.length, 0, "Borrowed operation connection survived return");
			assert.equal((yield* runtime.bootSql<{ value: number }>`SELECT 2 AS value`)[0]?.value, 2);
		}
		return runtime.rootAttempt;
	}).pipe(Effect.scoped);
	const attempt = yield* exercise.pipe(Effect.catchCause(() => Effect.die(`Remote runtime failed at ${phase}`)));
	const receipt = yield* fs.readFileString(`${root}/remote-owners/${attempt}.json`).pipe(
		Effect.flatMap(
			Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						state: Schema.String,
						sessions: Schema.Array(Schema.Struct({ database: Schema.String, username: Schema.String })),
					}),
				),
			),
		),
	);
	assert.equal(receipt.state, "closed");
	assert(receipt.sessions.some((session) => session.database === config.app.database));
	assert(receipt.sessions.some((session) => session.database === config.boot.database));
	assert(
		receipt.sessions.every(
			(session) =>
				session.username === config.bootConnection.username ||
				session.username.startsWith(`${config.bootConnection.username}@`),
		),
	);
	yield* Effect.scoped(remoteOwnerInventory(root));
	console.log("REMOTE_RUNTIME_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
await Effect.runPromise(program).catch(() => {
	throw new Error("Remote runtime acceptance failed; no credentials recorded");
});
