import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Console, Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { DbOps, layer } from "../../src/db-ops.ts";

const main = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing copy fixture arguments");
	const sql = yield* SqlClient.SqlClient;
	if (mode === "schema") {
		const initialized = yield* initializeBootSchema.pipe(Effect.result);
		return {
			result: initialized._tag,
			error: initialized._tag === "Failure" ? initialized.failure : null,
			journal: [],
			copied: null,
			destination: false,
			original: null,
		};
	}
	yield* initializeBootSchema;
	const fs = yield* FileSystem.FileSystem;
	const source = `${root}/app.db`;
	const original = new Database(source);
	yield* Effect.addFinalizer(() => Effect.sync(() => original.close()));
	original.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS records(value TEXT)");
	if (original.query("SELECT * FROM records").all().length === 0)
		original.exec("INSERT INTO records VALUES('acknowledged WAL write')");
	const ops = yield* DbOps.pipe(Effect.provide(layer({ _tag: "file", filename: source }, root)));
	const copying = ops.clone({ _tag: "file", filename: `${root}/copy.db` });
	const result = yield* (
		mode === "copy" ? copying : mode === "interrupt" ? copying.pipe(Effect.timeout("1 second")) : ops.recoverCopy
	).pipe(Effect.result);
	const journal = yield* sql`SELECT value FROM settings WHERE key='sqlite_copy'`;
	let copied: unknown = null;
	if (result._tag === "Success" && mode === "copy") {
		const db = new Database(`${root}/copy.db`, { readonly: true });
		try {
			copied = db.query("SELECT * FROM records").all();
		} finally {
			db.close();
		}
	}
	return {
		result: result._tag,
		error: result._tag === "Failure" ? result.failure : null,
		journal,
		copied,
		destination: yield* fs.exists(`${root}/copy.db`),
		original: original.query("SELECT * FROM records").all(),
	};
}).pipe(
	Effect.provide(SqliteClient.layer({ filename: `${process.argv[2]}/boot.db`, disableWAL: true })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
);
main.pipe(
	Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))),
	Effect.flatMap(Console.log),
	BunRuntime.runMain,
);
