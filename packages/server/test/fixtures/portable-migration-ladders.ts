import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { testStore } from "./test-store.ts";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { BootChannel } from "../../src/kernel/boot-channel.ts";
import { makeExtensionMigrate } from "../../src/kernel/extension-migrations.ts";
import { migrate } from "../../src/kernel/migrations.ts";
import system from "../../src/ext/system.ts";
import subscriptions from "../../src/ext/subscriptions/index.ts";
import type { Api } from "../../src/kernel/extension-api.ts";

const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite"]))(process.argv[2]);
const bootNames = [
	"generations",
	"settings",
	"edit_lock",
	"authentication",
	"source_history",
	"events",
	"enrollment",
	"refresh",
	"cutover",
	"session_activity",
	"mint_receipts",
	"backup_metadata",
	"recovery_journals",
	"event_filters",
	"combined_restore",
	"reset_pin",
	"store_identity",
	"backup_engine",
	"sqlite_copy_ownership",
	"passkey_origins",
] as const;
const coreNames = [
	"messages",
	"reads",
	"message_edits",
	"topic_edits_search",
	"agents_kv",
	"topic_deletion",
	"idempotency_mentions",
	"topic_page_continuations",
	"mention_word_boundaries",
	"mention_punctuation",
	"domain_json",
	"search_diacritics",
	"mention_symbol_boundaries",
	"protection_ownership",
] as const;
const names = (values: readonly string[]) => values.map((name, index) => ({ migration_id: index + 1, name }));
const scratch = () => testStore({ engine, config: undefined, database: "unused", tables: [] });
const unavailable = () => Effect.die("Unexpected non-migration capability");
const boot: BootChannel["Service"] = {
	epoch: "ladder",
	filename: null,
	store: { _tag: "file", filename: "/unused/app.db" },
	generation: 1,
	backup: Effect.die("Unexpected backup"),
	fence: unavailable(),
	changed: unavailable,
	events: unavailable,
	reserve: unavailable,
	append: unavailable,
	abort: unavailable,
};
const extensionApi = (migrate: Api["migrate"]): Api => ({
	migrate,
	context: unavailable,
	effects: {
		report: Effect.succeed({ records: [], overflow: 0 }),
		recordCron: unavailable,
		fetch: unavailable,
		notify: unavailable,
		timer: unavailable,
	},
	mount: () => {},
	page: () => {},
	cron: () => {},
	route: () => {},
	on: () => {},
});
const main = Effect.gen(function* () {
	const bootSql = yield* scratch();
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const ledger = yield* bootSql`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id`;
		assert.deepEqual(ledger, names(bootNames));
		yield* bootSql`INSERT INTO passkeys(id,public_key,counter,transports,label,created_at) VALUES('retained','key',7,'[]','fixture',1)`;
		yield* bootSql`INSERT INTO settings(${bootSql("key")},value) VALUES('retained','opaque')`;
		yield* initializeBootSchema;
		assert.deepEqual(yield* bootSql`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id`, ledger);
		assert.deepEqual(yield* bootSql`SELECT counter FROM passkeys WHERE id='retained'`, [{ counter: 7 }]);
		assert.deepEqual(yield* bootSql`SELECT value FROM settings WHERE ${bootSql("key")}='retained'`, [
			{ value: "opaque" },
		]);
		assert.deepEqual(yield* bootSql`SELECT ${bootSql("next")},published_through,pending_id FROM seq`, [
			{ next: 1, published_through: 0, pending_id: null },
		]);
		yield* bootSql`SELECT legacy_store_id,engine,generation FROM backups LIMIT 0`;
		yield* bootSql`SELECT reset_pin,pending_release FROM edit_lock LIMIT 0`;
		if (engine === "sqlite") assert.deepEqual(yield* bootSql`PRAGMA user_version`, [{ user_version: 20 }]);
	}).pipe(Effect.provideService(SqlClient.SqlClient, bootSql));
	const sql = yield* scratch();
	yield* Effect.gen(function* () {
		// Immutable ownership and physical fencing have separate tests. Supply their app SQL preconditions.
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,'ladder')`;
		yield* sql`CREATE TABLE mutation_batches(id VARCHAR(128) PRIMARY KEY,from_seq BIGINT,to_seq BIGINT,count BIGINT)`;
		yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(128),event TEXT,shipped_at BIGINT)`;
		yield* initializeRemoteKernelSchema(sql, "ladder");
		yield* initialize;
		assert.deepEqual(yield* sql`SELECT migration_id,name FROM core_migrations ORDER BY migration_id`, names(coreNames));
		for (const [name, load] of [
			["system.ts", system],
			["subscriptions", subscriptions],
		] as const)
			yield* load(extensionApi(yield* makeExtensionMigrate(sql, "ladder", name)));
		const extensions = yield* sql`SELECT extension,name,checksum FROM extension_migrations ORDER BY extension,name`;
		assert.deepEqual(
			extensions.map(({ extension, name }) => ({ extension, name })),
			[
				{ extension: "subscriptions", name: "webhook_subscriptions" },
				{ extension: "system.ts", name: "system_cursor" },
			],
		);
		assert.ok(extensions.every((row) => typeof row.checksum === "string" && /^[a-f0-9]{64}$/.test(row.checksum)));
		yield* sql`INSERT INTO topics(path,name,meta,last_seq,created_at) VALUES('retained','Retained','{}',1,1)`;
		yield* sql`INSERT INTO system_cursor(id,seq) VALUES(1,42)`;
		// Execute every checked-in editable module; the two current directories contain README only.
		const fs = yield* FileSystem.FileSystem;
		for (const directory of [
			`${import.meta.dirname}/../../migrations`,
			`${import.meta.dirname}/../../src/migrations`,
		]) {
			const files = (yield* fs.readDirectory(directory)).filter((file) => file !== "README.md");
			const applied = yield* migrate(directory, "ladder");
			assert.equal(applied.length, files.length);
			assert.deepEqual(yield* migrate(directory, "ladder"), []);
		}
		const coreLedger = yield* sql`SELECT * FROM core_migrations ORDER BY migration_id`;
		const editableLedger = yield* sql`SELECT * FROM migrations ORDER BY migration_id`;
		yield* initializeRemoteKernelSchema(sql, "ladder");
		yield* initialize;
		for (const [name, load] of [
			["system.ts", system],
			["subscriptions", subscriptions],
		] as const)
			yield* load(extensionApi(yield* makeExtensionMigrate(sql, "ladder", name)));
		assert.deepEqual(yield* sql`SELECT * FROM core_migrations ORDER BY migration_id`, coreLedger);
		assert.deepEqual(yield* sql`SELECT * FROM migrations ORDER BY migration_id`, editableLedger);
		assert.deepEqual(
			yield* sql`SELECT extension,name,checksum FROM extension_migrations ORDER BY extension,name`,
			extensions,
		);
		assert.deepEqual(yield* sql`SELECT name FROM topics WHERE path='retained'`, [{ name: "Retained" }]);
		assert.deepEqual(yield* sql`SELECT seq FROM system_cursor`, [{ seq: 42 }]);
		assert.deepEqual(yield* sql`SELECT name FROM protected_sql_tables ORDER BY name`, [
			{ name: "topic_page_continuations" },
			{ name: "webhook_subscriptions" },
		]);
		yield* sql`SELECT id,input,start_seq,cursor,attempts,last_error FROM webhook_subscriptions LIMIT 0`;
		if (engine === "sqlite") assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 14 }]);
	}).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provideService(BootChannel, boot));
}).pipe(Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer)), Effect.scoped);
await Effect.runPromise(main);
process.stdout.write("PORTABLE_LADDERS_VERIFIED\n");
