import { Redacted } from "effect";
import { render } from "@comms/storage/store";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Config, Console, Deferred, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { DbOps, layer as backupLayer } from "../../../boot/src/db-ops.ts";

const run = Effect.gen(function* () {
	const filename = yield* Config.String("LIVE_DATABASE");
	const entry = yield* Config.String("REHEARSAL_ENTRY");
	return yield* Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const temporary = yield* fs.makeTempDirectoryScoped();
		const clone = path.join(temporary, "clone.db");
		const pages = path.join(temporary, "pages");
		yield* fs.makeDirectory(pages);
		const backup = yield* DbOps;
		yield* backup.clone({ _tag: "file", filename: clone });
		yield* backup.prepareClone({ _tag: "file", filename: clone }, "rehearsal-test");
		const initial = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql`SELECT next FROM seq WHERE singleton=1`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ next: Schema.Int })))),
			);
			if (!rows[0]) return yield* Effect.die("Missing boot allocator");
			return rows[0].next;
		}).pipe(
			Effect.provide(SqliteClient.layer({ filename: path.join(path.dirname(filename), "boot.db"), disableWAL: true })),
			Effect.scoped,
		);
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const child = yield* spawner.spawn(
			ChildProcess.make(process.execPath, [entry], {
				env: {
					PORT: "0",
					BOOT_SECRET: "private-rehearsal-secret",
					WRITER_EPOCH: "rehearsal-test",
					APP_STORE: Redacted.value(yield* render({ _tag: "file", filename: clone })),
					APP_DATABASE: clone,
					PAGES_DIRECTORY: pages,
					STATE: "rehearsal",
					GENERATION: "0",
					REHEARSAL_SEQUENCE: String(initial),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "inherit",
				forceKillAfter: "2 seconds",
			}),
		);
		const announced = yield* Deferred.make<number>();
		let pending = "";
		yield* child.stdout.pipe(
			Stream.decodeText(),
			Stream.runForEach((chunk) =>
				Effect.gen(function* () {
					pending += chunk;
					const port = /COMMS_CHILD_PORT=(\d+)/.exec(pending)?.[1];
					if (port) yield* Deferred.succeed(announced, Number(port));
				}),
			),
			Effect.forkScoped,
		);
		const port = yield* Deferred.await(announced).pipe(Effect.timeout("5 seconds"));
		const client = yield* HttpClient.HttpClient;
		let status = 503;
		for (let attempt = 0; attempt < 50 && status !== 200; attempt++) {
			yield* Effect.sleep("20 millis");
			const response = yield* client.execute(
				HttpClientRequest.get(`http://127.0.0.1:${port}/health`, {
					headers: { "x-boot-secret": "private-rehearsal-secret" },
				}),
			);
			status = response.status;
		}
		const rows = yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql`SELECT body FROM messages ORDER BY seq`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ body: Schema.String })))),
			);
		}).pipe(Effect.provide(SqliteClient.layer({ filename: clone, disableWAL: true })), Effect.scoped);
		yield* Console.log(
			yield* Schema.encodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						status: Schema.Int,
						initial: Schema.Int,
						rows: Schema.Array(Schema.Struct({ body: Schema.String })),
					}),
				),
			)({ status, initial, rows }),
		);
	}).pipe(
		Effect.provide(
			backupLayer({ _tag: "file", filename }, filename.slice(0, filename.lastIndexOf("/"))).pipe(
				Layer.provide(SqliteClient.layer({ filename: filename.replace(/[^/]+$/, "boot.db"), disableWAL: true })),
			),
		),
	);
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)));
run.pipe(BunRuntime.runMain);
