// Read-only source proof after the actual coordinator's first retirement commit.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { inspectSqliteSnapshot } from "./transfer-acceptance-sqlite-snapshot.ts";
import { Schema } from "effect";
import { TransferFileJournal } from "../packages/storage/src/store-transfer-schema.ts";
const [id] = process.argv.slice(2);
assert(id && /^[a-f0-9-]{36}$/.test(id));
const directory = `/data/transfers/${id}`;
const journal = Schema.decodeSync(Schema.fromJsonString(TransferFileJournal))(
	readFileSync(`${directory}/journal.json`, "utf8"),
);
assert(journal.phase === "in_progress");
assert(!existsSync(`${directory}/journal.json.next`));
assert.equal(journal.binding.transfer_id, id);
assert.equal(journal.binding.source.engine, "sqlite");
assert.equal(journal.binding.source.boot, "/data/boot.db");
assert(journal.binding.source.app.startsWith("/data/store/"));
inspectSqliteSnapshot(journal.binding.source.boot, (boot) =>
	inspectSqliteSnapshot(journal.binding.source.app, (app) => {
		const retired = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(
			boot.query("SELECT value FROM settings WHERE key='transferred_to'").get(),
		);
		assert.deepEqual(JSON.parse(retired.value), journal.binding);
		const identity = Schema.decodeUnknownSync(Schema.Struct({ store_id: Schema.String, transferred_to: Schema.Null }))(
			app.query("SELECT store_id,transferred_to FROM store_identity WHERE singleton=1").get(),
		);
		assert.equal(identity.store_id, journal.binding.store_id);
	}),
);
console.log("Instrumented retirement crash retained exact boot binding and unretired app");
