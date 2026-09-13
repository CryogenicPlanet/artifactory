/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { SqlClient } from "effect/unstable/sql";
import { appStoreIdentity, verifyAppIdentity } from "../../src/app-store-identity.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { Console, Effect, FileSystem, Schema } from "effect";
import { ChildError } from "../../src/child-process.ts";
import { DbOps, layer } from "../../src/db-ops.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing test directory");
	const filename = `${root}/app.db`;
	yield* initializeBootSchema;
	const identity = yield* appStoreIdentity(filename);
	const adoption = yield* identity.reserve;
	yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql.withTransaction(verifyAppIdentity(adoption, true));
		}).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true }))),
	);
	yield* identity.complete(adoption);
	const store = { _tag: "file", filename } as const;
	const backup = yield* DbOps.pipe(Effect.provide(layer(store, root)));
	if (process.argv[3] === "foreign") {
		const errors: string[] = [];
		const before = yield* identity.current;
		const fs = yield* FileSystem.FileSystem;
		const bytes = yield* fs.readFile(filename);
		for (const engine of ["pg", "mysql"] as const) {
			const result = yield* backup
				.restoreInto({ path: `${root}/missing.db`, legacy_store_id: adoption.store_id, engine })
				.pipe(Effect.result);
			if (result._tag !== "Failure" || !Schema.is(ChildError)(result.failure))
				return yield* Effect.die("Expected typed engine refusal");
			errors.push(result.failure.code);
			const current = yield* identity.current;
			assert.deepEqual(current, before);
			assert.deepEqual(yield* fs.readFile(filename), bytes);
		}
		return errors;
	}
	if (process.argv[3] === "restore") {
		const original = new Database(filename);
		try {
			original.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before backup')");
		} finally {
			original.close();
		}
		yield* backup.clone({ _tag: "file", filename: `${root}/backup.db` });
		const changed = new Database(filename);
		try {
			changed.exec("PRAGMA journal_mode=WAL; INSERT INTO records VALUES('after backup')");
		} finally {
			changed.close();
		}
		// Every independently opened handle is closed before the production restore helper replaces files.
		const selected = yield* backup.restoreInto({ path: `${root}/backup.db`, legacy_store_id: null, engine: "sqlite" });
		assert.strictEqual(selected, store);
		const restored = new Database(filename);
		try {
			return restored.query<{ value: string }, []>("SELECT value FROM records").all();
		} finally {
			restored.close();
		}
	}
	const bootstrap = new Database(filename);
	try {
		bootstrap.exec(
			"CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT); INSERT INTO kernel_writer VALUES(1,'before'); CREATE TABLE outbox(seq INTEGER PRIMARY KEY); INSERT INTO outbox VALUES(25)",
		);
	} finally {
		bootstrap.close();
	}
	yield* backup.prepareClone({ _tag: "file", filename: filename }, "rehearsal");
	const initialized = new Database(filename);
	let epoch: unknown;
	try {
		epoch = initialized.query("SELECT epoch FROM kernel_writer").get();
		initialized.exec("PRAGMA user_version=1");
	} finally {
		initialized.close();
	}
	// Clone preparation owns only the kernel fence; editable domain schema is validated by child health.
	const prepared = yield* backup.prepareClone({ _tag: "file", filename: filename }, "second-probe").pipe(Effect.result);
	return { epoch, prepared: prepared._tag };
}).pipe(
	Effect.provide(SqliteClient.layer({ filename: `${process.argv[2]}/boot.db`, disableWAL: true })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
);
main.pipe(BunRuntime.runMain);
