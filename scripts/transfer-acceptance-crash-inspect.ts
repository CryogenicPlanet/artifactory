// Test-only, read-only proof after the instrumented outer process has died.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { TransferFileJournal } from "../packages/storage/src/store-transfer-schema.ts";

const [id] = process.argv.slice(2);
assert(id && /^[a-f0-9-]{36}$/.test(id), "Disposable transfer ID required");
const directory = `/data/transfers/${id}`;
const decode = Schema.decodeSync(Schema.fromJsonString(TransferFileJournal));
const journal = decode(readFileSync(`${directory}/journal.json`, "utf8"));
const staged = decode(readFileSync(`${directory}/journal.json.next`, "utf8"));
assert(journal.phase === "in_progress", "Authoritative activation advanced after crash");
assert(staged.phase === "complete", "Final activation checkpoint was not reached");
assert.deepEqual(staged.binding, journal.binding);
assert.equal(journal.binding.transfer_id, id);
assert.equal(journal.binding.source.engine, "sqlite");
assert.equal(journal.binding.source.boot, "/data/boot.db");
assert(journal.binding.source.app.startsWith("/data/store/"));
for (const [filename, query] of [
	[journal.binding.source.boot, "SELECT value AS marker FROM settings WHERE key='transferred_to'"],
	[journal.binding.source.app, "SELECT transferred_to AS marker FROM store_identity WHERE singleton=1"],
]) {
	assert(filename && query);
	const database = new Database(filename, { readonly: true });
	try {
		const row = Schema.decodeUnknownSync(Schema.Struct({ marker: Schema.String }))(database.query(query).get());
		assert.deepEqual(JSON.parse(row.marker), journal.binding, "Source retirement binding differs");
	} finally {
		database.close();
	}
}
console.log("Instrumented activation crash retained SQL retirement and incomplete filesystem authority");
