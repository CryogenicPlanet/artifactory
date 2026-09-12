import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Statement } from "effect/unstable/sql/Statement";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { remoteAppKernelSchema } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteCore } from "../../src/ext/core/core-schema-remote.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { writerGate } from "../../src/kernel/database.ts";

const Settings = Schema.Struct({
	engine: Schema.Literal("pg"),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const readSettings = async (filename: string | undefined) => {
	if (!filename) throw new Error("Missing disposable role configuration");
	return Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
};
const boot = await readSettings(process.env.COMMS_REMOTE_SCHEMA_BOOT_CONFIG);
const app = await readSettings(process.env.COMMS_REMOTE_SCHEMA_APP_CONFIG);
assert(boot.database.startsWith("comms_schema_"), "Disposable schema database required");
assert.equal(app.database, boot.database);
assert.equal(app.host, boot.host);
assert.equal(app.port, boot.port);
assert.notEqual(app.username, boot.username, "Separate boot and app credentials are required");
const client = (settings: typeof Settings.Type, attempt: string) => {
	const options = { connection: { ...settings, password: Redacted.make(settings.password), tls: false }, attempt };
	return remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
		Layer.provide(remoteInspectorLayer(options)),
	);
};
const bootLayer = client(boot, "b2".repeat(32));
const appLayer = client(app, "a2".repeat(32));
const identity = "4e08c35d-4b6c-4efa-81fc-93b19dd40c73";
const epoch = "ownership-probe";

/** Even an unexpectedly permitted destructive statement is rolled back before the assertion fails. */
const denied = (sql: SqlClient, statement: Statement<unknown>) =>
	Effect.gen(function* () {
		const result = yield* sql
			.withTransaction(statement.pipe(Effect.andThen(Effect.fail({ unexpectedSuccess: true }))))
			.pipe(Effect.result);
		assert(Result.isFailure(result));
		assert("reason" in result.failure, "A protected operation unexpectedly succeeded");
		// The public guarded client redacts driver authorization details.
		assert.equal(result.failure.reason._tag, "UnknownError");
		assert.equal(result.failure.reason.message, "remote_query_failed");
	});
const protectedOwners = (sql: SqlClient) =>
	Effect.gen(function* () {
		const objects =
			yield* sql`SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('kernel_writer','mutation_batches','outbox','store_identity','outbox_unshipped','outbox_transaction') ORDER BY c.relname`;
		assert.deepEqual(
			objects,
			["kernel_writer", "mutation_batches", "outbox", "outbox_transaction", "outbox_unshipped", "store_identity"].map(
				(name) => ({ name, owner: boot.username }),
			),
		);
	});

// Requires an initially empty disposable database. The environment provisions roles and database/schema ownership. This fixture grants only production table privileges.
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		assert.deepEqual(yield* sql`SELECT rolsuper FROM pg_roles WHERE rolname=current_user`, [{ rolsuper: false }]);
		for (let retry = 0; retry < 2; retry++)
			for (const operation of remoteAppKernelSchema(sql, app.username)) yield* operation;
		yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES (1,${epoch})`;
		yield* sql`INSERT INTO store_identity(singleton,store_id,initialized_at) VALUES (1,${identity},1800000000000)`;
		yield* protectedOwners(sql);
	}).pipe(Effect.scoped, Effect.provide(bootLayer)),
);

await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		assert.deepEqual(yield* sql`SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`, [
			{ rolsuper: false, rolcreatedb: false, rolcreaterole: false },
		]);
		assert.deepEqual(yield* sql`SELECT pg_has_role(current_user,${boot.username},'MEMBER') AS member`, [
			{ member: false },
		]);
		assert.deepEqual(
			yield* sql`SELECT pg_has_role(current_user,d.datdba,'USAGE') AS database_owner,pg_has_role(current_user,n.nspowner,'USAGE') AS schema_owner FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=current_database() AND n.nspname='public'`,
			[{ database_owner: false, schema_owner: false }],
		);
		for (let retry = 0; retry < 2; retry++) {
			yield* initializeRemoteKernelSchema(sql, epoch);
			yield* initializeRemoteCore(sql, epoch);
		}
		yield* protectedOwners(sql);
		assert.deepEqual(
			yield* sql`SELECT has_table_privilege(current_user,'public.outbox','SELECT') AS "read",has_table_privilege(current_user,'public.outbox','INSERT') AS "insert",has_table_privilege(current_user,'public.outbox','UPDATE') AS "update",has_table_privilege(current_user,'public.outbox','DELETE') AS "delete"`,
			[{ read: true, insert: true, update: true, delete: true }],
		);
		assert.deepEqual(
			yield* sql`SELECT has_table_privilege(current_user,'public.store_identity','SELECT') AS "read",has_table_privilege(current_user,'public.store_identity','INSERT') AS "insert",has_table_privilege(current_user,'public.store_identity','UPDATE') AS "update",has_table_privilege(current_user,'public.store_identity','DELETE') AS "delete",has_table_privilege(current_user,'public.store_identity','TRUNCATE') AS "truncate"`,
			[{ read: true, insert: false, update: false, delete: false, truncate: false }],
		);
		yield* sql`CREATE TABLE ownership_app_probe(id INTEGER PRIMARY KEY,note TEXT NOT NULL)`;
		yield* sql`INSERT INTO ownership_app_probe VALUES (1,'app-owned durable row')`;
		assert.deepEqual(
			yield* sql`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.ownership_app_probe'::regclass`,
			[{ owner: app.username }],
		);
		const unaccent = yield* sql`SELECT name FROM pg_available_extensions WHERE name='unaccent'`;
		if (unaccent.length > 0) {
			yield* sql`CREATE EXTENSION IF NOT EXISTS unaccent`;
			assert.deepEqual(yield* sql`SELECT unaccent('résumé') AS plain`, [{ plain: "resume" }]);
		}
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				yield* sql`INSERT INTO outbox(seq,transaction_id,event,shipped_at) VALUES (1,'owned-transaction','{"type":"probe"}',NULL)`;
				yield* sql`UPDATE outbox SET shipped_at=1800000000000 WHERE seq=1`;
				yield* sql`INSERT INTO outbox(seq,transaction_id,event,shipped_at) VALUES (2,'discarded-transaction','{}',NULL)`;
				yield* sql`DELETE FROM outbox WHERE seq=2`;
			}),
		);
		for (const table of ["outbox", "store_identity"]) {
			yield* denied(sql, sql`ALTER TABLE ${sql(table)} ADD COLUMN forbidden INTEGER`);
			yield* denied(
				sql,
				sql`CREATE INDEX forbidden_ownership_index ON ${sql(table)} (${sql(table === "outbox" ? "seq" : "singleton")})`,
			);
			yield* denied(sql, sql`DROP TABLE ${sql(table)}`);
		}
		yield* denied(sql, sql`DROP SCHEMA public CASCADE`);
		yield* denied(sql, sql`UPDATE store_identity SET store_id='foreign' WHERE singleton=1`);
		yield* denied(sql, sql`DELETE FROM store_identity WHERE singleton=1`);
		yield* denied(sql, sql`INSERT INTO store_identity(singleton,store_id,initialized_at) VALUES (1,'foreign',1)`);
		yield* denied(sql, sql`TRUNCATE store_identity`);
		yield* protectedOwners(sql);
		assert.deepEqual(yield* sql`SELECT store_id FROM store_identity`, [{ store_id: identity }]);
	}).pipe(Effect.scoped, Effect.provide(appLayer)),
);

// A new scope uses new physical sessions after the first app client's connections close.
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		yield* initializeRemoteKernelSchema(sql, epoch);
		yield* initializeRemoteCore(sql, epoch);
		yield* protectedOwners(sql);
		assert.deepEqual(yield* sql`SELECT store_id FROM store_identity`, [{ store_id: identity }]);
		assert.deepEqual(yield* sql`SELECT note FROM ownership_app_probe`, [{ note: "app-owned durable row" }]);
		assert.deepEqual(yield* sql`SELECT seq,transaction_id,shipped_at FROM outbox`, [
			{ seq: 1, transaction_id: "owned-transaction", shipped_at: 1800000000000 },
		]);
		assert.equal((yield* sql`SELECT migration_id FROM core_migrations`).length, 12);
	}).pipe(Effect.scoped, Effect.provide(appLayer)),
);
process.stdout.write("separate PostgreSQL roles preserve protected ownership, app migrations and reconnect data\n");
