import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { FetchHttpClient } from "effect/unstable/http";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { SqlClient } from "effect/unstable/sql";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { remoteOwnerInventory } from "../../src/remote-owner-inventory.ts";
import { configuration } from "./remote-keeper-config.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.GUARDIAN_TEST_ROOT ?? process.argv[2] ?? "");
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
		if (process.env.GUARDIAN_ASSERT_APP_CLOSED === "true") {
			const sessions =
				config.appConnection.engine === "pg"
					? yield* runtime.bootSql`SELECT pid FROM pg_stat_activity WHERE usename = ${config.appConnection.username}`
					: yield* runtime.bootSql`SELECT PROCESSLIST_ID FROM performance_schema.threads WHERE PROCESSLIST_USER = ${config.appConnection.username} AND TYPE = 'FOREGROUND'`;
			assert.equal(sessions.length, 0, "Editable app account survived guardian receipt");
		}
		return runtime.rootAttempt;
	}).pipe(Effect.scoped);
	if (process.env.COMMS_REMOTE_ROOT_CONFIG) {
		yield* exercise.pipe(Effect.catchCause(() => Effect.die(`Remote runtime failed at ${phase}`)));
		return;
	}
	const previous = (yield* fs.exists(`${root}/remote-owners`)) ? yield* fs.readDirectory(`${root}/remote-owners`) : [];
	const exit = yield* Effect.scoped(
		launchRemoteRoot(config, {
			dataDirectory: root,
			entry: fileURLToPath(import.meta.url),
			env: { GUARDIAN_TEST_ROOT: root },
		}),
	);
	assert.equal(Number(exit), 0, "Boot SQL fixture did not finish");
	const created = (yield* fs.readDirectory(`${root}/remote-owners`)).filter(
		(name) => name.endsWith(".json") && !previous.includes(name),
	);
	assert.equal(created.length, 1);
	const attempt = created[0]?.slice(0, -5);
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
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)));
program.pipe(
	Effect.catchCause(() => Effect.die("Remote runtime acceptance failed; no credentials recorded")),
	BunRuntime.runMain,
);
