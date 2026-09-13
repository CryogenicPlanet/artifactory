import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Effect, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import { remoteMigrate } from "@comms/storage/remote-migrations";
import { initializeRemoteCore, remoteCoreSteps } from "../../src/ext/core/core-schema-remote.ts";
import { postgresSearchMode } from "../../src/ext/core/core-search-schema.ts";
import { remoteWriteGuard } from "../../src/kernel/sql-write-remote-guard.ts";
import { searchMessages } from "../../src/ext/core/search.ts";
const Settings = Schema.Struct({
	engine: Schema.Literal("pg"),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_UNACCENT_CONFIG;
const mode = process.env.COMMS_UNACCENT_MODE;
if (!filename || !["fresh", "upgrade", "denied"].includes(mode ?? ""))
	throw new Error("Unaccent fixture configuration missing");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
assert(settings.database.startsWith("comms_schema_unaccent"));
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
};
const layer = advisoryClientLayer(options);
let phase = "initialize";
try {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient;
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
			yield* sql`INSERT INTO kernel_writer VALUES (1,'unaccent-probe')`;
			yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(256) NOT NULL,event TEXT NOT NULL,shipped_at BIGINT)`;
			// This core-only fixture supplies the pre-core14 kernel registration table.
			yield* sql`CREATE TABLE protected_sql_tables(name VARCHAR(128) PRIMARY KEY)`;
			if (mode === "fresh") yield* initializeRemoteCore(sql, "unaccent-probe");
			else yield* remoteMigrate(sql, "core_migrations", remoteCoreSteps(sql).slice(0, 11));
			const prior = '{ "body": "naïve café", "untouched": [ 1, null ] }';
			yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,body,tags,meta,created_at,updated_seq,previous) VALUES ('current',1,'test','test','test','résumé café','[]','{}',1,10,NULL),('previous',2,'test','test','test','replacement','[]','{}',1,20,${prior})`;
			yield* sql`INSERT INTO outbox VALUES (1,'retained','{ "literal": "résumé" }',NULL)`;
			const before = yield* sql`SELECT id,body,previous FROM messages ORDER BY id`;
			if (mode !== "fresh") {
				phase = "rollback";
				const steps = remoteCoreSteps(sql).map((step) =>
					step.id !== 12
						? step
						: {
								...step,
								operations: step.operations.map((operation) => ({
									...operation,
									run: operation.run.pipe(Effect.andThen(Effect.fail("after_search_ddl"))),
								})),
							},
				);
				const interrupted = yield* remoteMigrate(sql, "core_migrations", steps).pipe(Effect.result);
				assert(Result.isFailure(interrupted));
				assert.equal(interrupted.failure, "after_search_ddl");
				assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 11);
				assert.equal(yield* postgresSearchMode(sql), "absent");
			}
			phase = "upgrade";
			yield* initializeRemoteCore(sql, "unaccent-probe");
			const folding = (yield* postgresSearchMode(sql)) === "folded";
			assert.equal(folding, mode !== "denied");
			phase = "search";
			const ids = (q: string) =>
				Effect.gen(function* () {
					const match = yield* searchMessages(sql, q, 10, folding);
					return yield* sql`SELECT id FROM messages WHERE ${match} ORDER BY id`;
				});
			assert.deepEqual(yield* ids("résumé"), [{ id: "current" }]);
			assert.deepEqual(yield* ids("resume"), folding ? [{ id: "current" }] : []);
			assert.deepEqual(yield* ids('"naive cafe"'), folding ? [{ id: "previous" }] : []);
			assert.deepEqual(yield* ids('"naïve café"'), [{ id: "previous" }]);
			assert.deepEqual(yield* ids("replacement"), []);
			assert.deepEqual(yield* sql`SELECT id,body,previous FROM messages ORDER BY id`, before);
			assert.deepEqual(yield* sql`SELECT event FROM outbox`, [{ event: '{ "literal": "résumé" }' }]);
			phase = "altered_wrapper_refused";
			const altered = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const body = folding
							? "SELECT public.unaccent('public.unaccent'::pg_catalog.regdictionary, value)"
							: "SELECT value";
						yield* sql.unsafe(
							`CREATE OR REPLACE FUNCTION public.comms_unaccent(value text DEFAULT 'unexpected') RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $body$${body}$body$`,
						);
						assert(Result.isFailure(yield* postgresSearchMode(sql).pipe(Effect.result)));
						assert(Result.isFailure(yield* remoteWriteGuard(sql, "pg", [], "messages").pipe(Effect.result)));
						return yield* Effect.fail("undo_wrapper_probe");
					}),
				)
				.pipe(Effect.result);
			assert(Result.isFailure(altered));
			assert.equal(altered.failure, "undo_wrapper_probe");
			phase = "restart";
			yield* initializeRemoteCore(sql, "unaccent-probe");
			assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 14);
			assert.equal((yield* postgresSearchMode(sql)) === "folded", folding);
		}).pipe(Effect.provide(layer), Effect.scoped),
	);
	phase = "reconnect";
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient;
			yield* initializeRemoteCore(sql, "unaccent-probe");
			assert.equal((yield* postgresSearchMode(sql)) === "folded", mode !== "denied");
			assert.deepEqual(yield* sql`SELECT event FROM outbox`, [{ event: '{ "literal": "résumé" }' }]);
		}).pipe(Effect.provide(layer), Effect.scoped),
	);
	process.stdout.write(`PostgreSQL unaccent ${mode}: passed\n`);
} catch {
	throw new Error(`PostgreSQL unaccent ${mode} failed during ${phase}`);
}
