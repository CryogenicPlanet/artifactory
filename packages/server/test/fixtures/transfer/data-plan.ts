import assert from "node:assert/strict";
import { BunCrypto } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { transferInventory } from "@comms/storage/transfer-inventory";
import { Context, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { prepareTransferData } from "../../../src/transfer/data-plan.ts";
const root = process.argv[2];
const mode = process.argv[3];
if (!root) throw new Error("Missing root");
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const open = (name: string) =>
				Layer.build(clientLayer({ _tag: "file", filename: `${root}/${name}.db` })).pipe(
					Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
				);
			const source = yield* open("source");
			const target = yield* open("target");
			for (const sql of [source, target]) {
				yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)`;
				yield* sql`CREATE TABLE seq(singleton INTEGER PRIMARY KEY,next INTEGER NOT NULL)`;
				yield* sql`CREATE TABLE boot_migrations(migration_id INTEGER PRIMARY KEY,name TEXT NOT NULL,created_at TIMESTAMP NOT NULL)`;
				yield* sql`CREATE TABLE custom_parent(id INTEGER PRIMARY KEY,value TEXT NOT NULL)`;
				yield* sql`CREATE TABLE custom_child(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL REFERENCES custom_parent(id),value BLOB NOT NULL)`;
				yield* sql`INSERT INTO settings VALUES('control',${sql === source ? "source" : "target"})`;
				yield* sql`INSERT INTO seq VALUES(1,${sql === source ? 90 : 1})`;
			}
			yield* source`INSERT INTO custom_parent VALUES(42,'日本語😀')`;
			yield* source`INSERT INTO custom_child VALUES(3,42,${new Uint8Array([0, 255, 1])})`;
			const plan = yield* prepareTransferData({
				store: "boot",
				source: { sql: source, engine: "sqlite", inventory: yield* transferInventory(source) },
				target: { sql: target, engine: "sqlite", inventory: yield* transferInventory(target) },
			});
			assert.equal((yield* target`SELECT 1 FROM custom_parent`).length, 0);
			assert.deepEqual(
				plan.manifest.tables.map((table) => table.table.name),
				["custom_parent", "custom_child"],
			);
			if (mode === "changed-source") {
				yield* source`UPDATE custom_parent SET value='changed'`;
				assert.ok(Exit.isFailure(yield* plan.copy.pipe(Effect.exit)));
				assert.equal((yield* target`SELECT 1 FROM custom_parent`).length, 0);
			} else if (mode === "populated-target") {
				yield* target`INSERT INTO custom_parent VALUES(7,'foreign')`;
				assert.ok(Exit.isFailure(yield* plan.copy.pipe(Effect.exit)));
				assert.deepEqual(yield* target`SELECT value FROM custom_parent`, [{ value: "foreign" }]);
			} else {
				yield* plan.copy;
				yield* plan.verify;
				yield* target`UPDATE custom_child SET value=${new Uint8Array([2])}`;
				assert.ok(Exit.isFailure(yield* plan.verify.pipe(Effect.exit)));
			}
			assert.deepEqual(yield* target`SELECT value FROM settings`, [{ value: "target" }]);
			assert.deepEqual(yield* target`SELECT next FROM seq`, [{ next: 1 }]);
			console.log("Verified", mode);
		}),
	).pipe(Effect.provide(BunCrypto.layer)),
);
