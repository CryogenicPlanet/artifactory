import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "../../src/client.ts";
import { transferInventory } from "../../src/transfer-inventory.ts";

const filename = process.argv[2];
const mode = process.argv[3];
if (!filename) throw Error("Missing fixture path");
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		if (mode === "custom") {
			yield* sql`CREATE TABLE parent(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID`;
			yield* sql`CREATE TABLE custom(id INTEGER PRIMARY KEY AUTOINCREMENT,a TEXT,b INTEGER,payload BLOB,derived TEXT GENERATED ALWAYS AS (a || b) STORED,FOREIGN KEY(a,b) REFERENCES parent(a,b) ON UPDATE CASCADE ON DELETE RESTRICT)`;
		} else if (mode === "deferred" || mode === "match") {
			yield* sql`CREATE TABLE parent(id INTEGER PRIMARY KEY)`;
			if (mode === "deferred")
				yield* sql`CREATE TABLE custom(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`;
			else yield* sql`CREATE TABLE custom(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES parent(id) MATCH FULL)`;
		} else if (mode === "fts" || mode === "untrusted-fts") {
			yield* sql`CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT)`;
			yield* sql`CREATE VIRTUAL TABLE search USING fts5(body)`;
			yield* sql`CREATE TABLE search_custom(payload BLOB)`;
		} else if (mode === "expression") {
			yield* sql`CREATE TABLE custom(value TEXT)`;
			yield* sql`CREATE INDEX executable ON custom(lower(value))`;
		} else if (mode === "trigger") {
			yield* sql`CREATE TABLE custom(id INTEGER)`;
			yield* sql`CREATE TRIGGER hidden_write AFTER INSERT ON custom BEGIN UPDATE custom SET id=7; END`;
		} else if (mode === "view") {
			yield* sql`CREATE VIEW hidden_data AS SELECT 1`;
		} else if (mode === "type") {
			yield* sql`CREATE TABLE custom(amount DECIMAL(30,10))`;
			yield* sql`CREATE TABLE boot_migrations(migration_id INTEGER PRIMARY KEY,created_at DATETIME,name TEXT)`;
		}
		const result = yield* transferInventory(
			sql,
			mode === "fts"
				? [{ name: "search", kind: "table", definition: "CREATE VIRTUAL TABLE search USING fts5(body)" }]
				: [],
		).pipe(Effect.result);
		process.stdout.write(
			JSON.stringify(
				result._tag === "Success"
					? { _tag: result._tag, success: result.success }
					: { _tag: result._tag, failure: result.failure },
			),
		);
	}).pipe(Effect.provide(clientLayer({ _tag: "file", filename }))),
);
