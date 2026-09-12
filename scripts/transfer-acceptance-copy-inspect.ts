// Read-only proof for a worker killed after its messages table committed.
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
assert(!existsSync(`${directory}/journal.json.next`), "Partial copy must not stage activation");
assert.equal(journal.binding.transfer_id, id);
assert.equal(journal.binding.source.engine, "sqlite");
assert.equal(journal.binding.source.boot, "/data/boot.db");
assert(journal.binding.source.app.startsWith("/data/store/"));
inspectSqliteSnapshot(journal.binding.source.boot, (boot) =>
	inspectSqliteSnapshot(journal.binding.source.app, (app) => {
		assert.equal(boot.query("SELECT value FROM settings WHERE key='transferred_to'").get(), null);
		const identity = Schema.decodeUnknownSync(Schema.Struct({ transferred_to: Schema.Null, store_id: Schema.String }))(
			app.query("SELECT transferred_to,store_id FROM store_identity WHERE singleton=1").get(),
		);
		assert.equal(identity.store_id, journal.binding.store_id);
		const rows = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
			app.query("SELECT COUNT(*) AS count FROM messages").get(),
		);
		assert(rows.count > 0);
		console.log(rows.count);
	}),
);
