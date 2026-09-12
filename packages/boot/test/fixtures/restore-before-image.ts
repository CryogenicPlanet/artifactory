import { BunRuntime, BunServices } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { Console, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { restoreBeforeImage } from "../../src/restore-before-image.ts";

const root = process.argv[2];
const mode = process.argv[3];
if (!root) throw Error("Missing root");
const storeId = "f300811c-10dc-4b41-a691-8c10dc49b421";
const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
	yield* sql`PRAGMA synchronous=FULL`;
	const before = yield* restoreBeforeImage(root, `${root}/comms.db`);
	if (mode === "prepare" || mode === "uncommitted") {
		const manifest = yield* before.prepare(storeId);
		if (mode === "prepare") yield* sql.withTransaction(before.record("proof", manifest));
		return manifest;
	}
	if (mode === "rollback") yield* before.rollback("proof", storeId);
	if (mode === "wrong-store") yield* before.rollback("proof", "30e4d2e1-bd48-4c44-a716-94e7b5139f23");
	if (mode === "rebind") {
		const manifest = yield* before.prepare(storeId);
		yield* before.record("proof", manifest);
	}
	if (mode === "repeat-record") {
		const manifest = yield* before.read("proof");
		if (manifest) yield* before.record("proof", manifest);
	}
	if (mode === "tamper") {
		const manifest = yield* before.read("proof");
		if (!manifest) return yield* Effect.die("Missing manifest");
		const changes = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
			process.argv[4] ?? "{}",
		);
		const changed = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ ...manifest, ...changes });
		yield* sql`UPDATE settings SET value=${changed} WHERE key='restore-before:proof'`;
	}
	return yield* before.read("proof");
}).pipe(
	Effect.result,
	Effect.flatMap((result) => Console.log(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(result))),
	Effect.provide(clientLayer({ _tag: "file", filename: `${root}/boot.db` })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
);
main.pipe(BunRuntime.runMain);
