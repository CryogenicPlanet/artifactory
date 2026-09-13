import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Effect, Ref, Redacted, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import { parseDescriptor } from "@comms/storage/store";
import { remoteAppKernelOperations } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { initializeRemoteCore } from "../../src/ext/core/core-schema-remote.ts";
import { type BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { makeMutate } from "../../src/kernel/mutate.ts";
import { makeOutboxRelay } from "../../src/kernel/outbox.ts";
import { writeSql } from "../../src/kernel/sql-write.ts";
import { registerProtectedSqlTable } from "../../src/kernel/protected-sql-tables.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_SQL_WRITE_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable write configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (settings.database !== "comms_schema_write") throw new Error("Requires isolated write database");
const url = new URL(`${settings.engine === "pg" ? "postgres" : "mysql"}://localhost`);
url.hostname = settings.host;
url.port = String(settings.port);
url.username = encodeURIComponent(settings.username);
url.password = encodeURIComponent(settings.password);
url.pathname = `/${settings.database}`;
const mode = process.argv[2];
let phase = "connect";
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const crypto = yield* Crypto.Crypto;
			const reset = Effect.gen(function* () {
				if (settings.engine === "pg") yield* sql`DROP FUNCTION IF EXISTS raw_write_trigger() CASCADE`.unprepared;
				const views = yield* (
					settings.engine === "pg"
						? sql`SELECT viewname AS name FROM pg_catalog.pg_views WHERE schemaname='public'`
						: sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='VIEW'`
				).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))));
				for (const { name } of views) yield* sql`DROP VIEW ${sql(name)}`.unprepared;
				const tables = yield* (
					settings.engine === "pg"
						? sql`SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname='public'`
						: sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`
				).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))));
				if (settings.engine === "mysql") yield* sql`SET FOREIGN_KEY_CHECKS=0`;
				for (const { name } of tables)
					yield* settings.engine === "pg" ? sql`DROP TABLE ${sql(name)} CASCADE` : sql`DROP TABLE ${sql(name)}`;
				if (settings.engine === "mysql") yield* sql`SET FOREIGN_KEY_CHECKS=1`;
			});
			if (mode === "cleanup") {
				yield* reset;
				return;
			}
			if (mode === "prepare") {
				phase = "schema";
				yield* reset;
				for (const operation of remoteAppKernelOperations(sql, settings.username).filter(
					({ name }) => !name.startsWith("grant:"),
				))
					yield* operation.run;
				yield* sql`INSERT INTO kernel_writer VALUES(1,'raw-write')`;
				yield* initializeRemoteKernelSchema(sql, "raw-write");
				yield* initializeRemoteCore(sql, "raw-write");
				yield* sql`CREATE TABLE repair_rows(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)`;
				yield* sql`INSERT INTO repair_rows VALUES(1,0)`;
				yield* sql`CREATE TABLE repair_guard(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL,FOREIGN KEY(parent) REFERENCES repair_rows(id) ON DELETE CASCADE)`;
				yield* sql`INSERT INTO repair_guard VALUES(1,1)`;
				yield* sql.withTransaction(registerProtectedSqlTable(sql, "repair_guard"));
			}
			let reserveCalls = 0;
			let next = 100;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const failing = yield* Ref.make(mode === "prepare");
			const boot: BootChannel["Service"] = {
				epoch: "raw-write",
				store: yield* parseDescriptor(url.href),
				filename: null,
				generation: 1,
				backup: Effect.void,
				changed: () => Effect.never,
				fence: Effect.succeed({ published_through: 1000 }),
				events: (input) => Effect.succeed({ items: [], cursor: input.since ?? 0, timed_out: false, drained: false }),
				reserve: (_transaction, count) =>
					Effect.sync(() => {
						reserveCalls++;
						const from = ++next;
						next += count - 1;
						return { transaction: _transaction, from, to: next };
					}),
				abort: () => Effect.void,
				append: (batch) =>
					Ref.get(failing).pipe(
						Effect.flatMap((fail) =>
							fail ? Effect.fail(unavailable()) : Effect.succeed({ published_through: batch.to }),
						),
					),
			};
			const relay = makeOutboxRelay(sql, boot);
			const mutate = makeMutate(sql, crypto, boot, relay, yield* Semaphore.make(1));
			const who = { agent: "human", instance: "raw-writer", request: "raw-repair", kind: "human" as const };
			const input = { sql: "UPDATE repair_rows SET value=value+1 WHERE id=1", params: [] };
			const write = (text: string, key?: string) => writeSql(sql, mutate, crypto, boot, who, { sql: text }, key);
			const unsupported = (text: string) =>
				write(text).pipe(
					Effect.result,
					Effect.tap((result) =>
						Effect.sync(() => {
							assert.equal(result._tag, "Failure");
							if (result._tag === "Failure") {
								assert(Schema.is(KernelError)(result.failure));
								assert.equal(result.failure.code, "sql_unsupported");
							}
						}),
					),
				);
			if (mode === "prepare") {
				phase = "foreign-key-rollback";
				yield* unsupported("DELETE FROM repair_rows WHERE id=1");
				assert.deepEqual(yield* sql`SELECT * FROM repair_rows`, [{ id: 1, value: 0 }]);
				assert.deepEqual(yield* sql`SELECT * FROM repair_guard`, [{ id: 1, parent: 1 }]);
				phase = "syntax-refusal";
				for (const statement of [
					"DROP TABLE repair_rows",
					"UPDATE public.repair_rows SET value=3",
					"UPDATE repair_rows r SET value=3",
					"WITH changed AS (UPDATE repair_rows SET value=3 RETURNING *) SELECT * FROM changed",
				])
					yield* unsupported(statement);
				phase = "trigger-refusal";
				if (settings.engine === "pg") {
					yield* sql`CREATE FUNCTION raw_write_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS 'BEGIN UPDATE repair_guard SET parent=parent; RETURN NEW; END'`
						.unprepared;
					yield* sql`CREATE CONSTRAINT TRIGGER raw_write_trigger AFTER UPDATE ON repair_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raw_write_trigger()`
						.unprepared;
				} else
					yield* sql`CREATE TRIGGER raw_write_trigger AFTER UPDATE ON repair_rows FOR EACH ROW UPDATE repair_guard SET parent=parent`
						.unprepared;
				yield* unsupported(input.sql);
				assert.deepEqual(yield* sql`SELECT value FROM repair_rows`, [{ value: 0 }]);
				if (settings.engine === "pg") yield* sql`DROP FUNCTION raw_write_trigger() CASCADE`.unprepared;
				else yield* sql`DROP TRIGGER raw_write_trigger`.unprepared;
				phase = "bound-refusal";
				for (let id = 2; id <= 1002; id++) yield* sql`INSERT INTO repair_guard VALUES(${id},1)`;
				yield* unsupported(input.sql);
				yield* sql`DELETE FROM repair_guard WHERE id>1`;
				phase = "commit-lost-publication";
				const result = yield* writeSql(sql, mutate, crypto, boot, who, input, "same-repair").pipe(Effect.result);
				assert.equal(result._tag, "Failure");
				if (result._tag === "Failure") {
					assert(Schema.is(KernelError)(result.failure));
					assert.equal(result.failure.code, "boot_unavailable");
				}
				assert.deepEqual(yield* sql`SELECT value FROM repair_rows`, [{ value: 1 }]);
				assert.equal((yield* sql`SELECT * FROM outbox`).length, 1);
				assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 1);
				assert.equal((yield* sql`SELECT * FROM idempotency WHERE kind='sql.write'`).length, 1);
			} else {
				phase = "physical-reconnect-replay";
				const [pending] = yield* sql`SELECT seq FROM outbox`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
				);
				assert(pending);
				const outcome = yield* writeSql(sql, mutate, crypto, boot, who, input, "same-repair");
				assert.deepEqual(outcome, {
					rows: [],
					truncated: false,
					changes: 1,
					seq: pending.seq,
					changes_scope: "direct",
					dialect: settings.engine,
				});
				assert.equal(reserveCalls, 0);
				assert.deepEqual(yield* sql`SELECT value FROM repair_rows`, [{ value: 1 }]);
				assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
				assert.equal((yield* sql`SELECT * FROM idempotency WHERE kind='sql.write'`).length, 1);
				const conflict = yield* write("UPDATE repair_rows SET value=9 WHERE id=1", "same-repair").pipe(Effect.result);
				assert.equal(conflict._tag, "Failure");
				if (conflict._tag === "Failure") {
					assert(Schema.is(KernelError)(conflict.failure));
					assert.equal(conflict.failure.code, "idempotency_conflict");
				}
				phase = "insert-delete-counts";
				assert.equal((yield* write("INSERT INTO repair_rows(id,value) VALUES(2,7)")).changes, 1);
				assert.equal((yield* write("UPDATE repair_rows SET value=7 WHERE id=2")).changes, 1);
				assert.equal((yield* write("DELETE FROM repair_rows WHERE id=2")).changes, 1);
				assert.deepEqual(yield* sql`SELECT * FROM repair_rows`, [{ id: 1, value: 1 }]);
				phase = "view-refusal";
				yield* sql`CREATE VIEW repair_view AS SELECT * FROM repair_rows`.unprepared;
				yield* unsupported("UPDATE repair_rows SET value=9 WHERE id=1");
				yield* sql`DROP VIEW repair_view`.unprepared;
				if (settings.engine === "mysql") {
					phase = "nontransactional-refusal";
					yield* sql`CREATE TABLE unsafe_repair(value INTEGER) ENGINE=MyISAM`;
					yield* unsupported("UPDATE repair_rows SET value=9 WHERE id=1");
					yield* sql`DROP TABLE unsafe_repair`;
				}
				assert.deepEqual(yield* sql`SELECT value FROM repair_rows`, [{ value: 1 }]);
			}
			console.log(`REMOTE_SQL_WRITE_VERIFIED ${mode}`);
		}),
	).pipe(
		Effect.provide(
			advisoryClientLayer({
				connection: { ...settings, password: Redacted.make(settings.password), tls: false },
			}),
		),
		Effect.provide(BunServices.layer),
	),
).catch(() => {
	throw new Error(`Remote SQL write fixture failed at ${phase}`);
});
