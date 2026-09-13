/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { DbOps, layer as operationsLayer } from "../../../boot/src/db-ops.ts";
import { BootChannel, layer as channelLayer } from "../../src/kernel/boot-channel.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing disposable directory");
	yield* initializeBootSchema;
	const source = `${root}/app.db`;
	const original = new Database(source);
	original.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('acknowledged')");
	original.close();
	const operations = yield* DbOps.pipe(Effect.provide(operationsLayer({ _tag: "file", filename: source }, root)));
	const sql = yield* SqlClient.SqlClient;
	const client = HttpClient.make((request, url) =>
		Effect.gen(function* () {
			assert.equal(url.pathname, "/_boot/db/backup");
			assert.equal(request.headers["x-boot-secret"], "fixture-secret");
			// This is the real immutable copy/keeper protocol, not a delayed mock response.
			const bytes = yield* operations.clone({ _tag: "file", filename: `${root}/saved.db` }).pipe(Effect.orDie);
			return HttpClientResponse.fromWeb(request, Response.json({ id: "saved", bytes: Number(bytes) }));
		}),
	);
	yield* Effect.gen(function* () {
		yield* (yield* BootChannel).backup;
	}).pipe(
		Effect.provide(channelLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					WRITER_EPOCH: "fixture",
					APP_STORE: `file:${source}`,
					APP_DATABASE: source,
					GENERATION: "1",
					STATE: "live",
					BOOT_URL: "http://localhost",
					BOOT_SECRET: "fixture-secret",
				}),
			),
		),
	);
	const saved = new Database(`${root}/saved.db`, { readonly: true });
	try {
		assert.deepEqual(saved.query("SELECT value FROM records").all(), [{ value: "acknowledged" }]);
	} finally {
		saved.close();
	}
	assert.deepEqual(yield* sql`SELECT value FROM settings WHERE key='sqlite_copy'`, []);
	return "copied-and-acknowledged";
}).pipe(
	Effect.provide(SqliteClient.layer({ filename: `${process.argv[2]}/boot.db`, disableWAL: true })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap(Console.log),
);
main.pipe(BunRuntime.runMain);
