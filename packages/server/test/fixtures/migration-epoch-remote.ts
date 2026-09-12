import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { remoteAppKernelSchema } from "../../../boot/src/app-kernel-schema.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { assertNoPendingMigration } from "../../src/kernel/migration-intent.ts";
import { migrate } from "../../src/kernel/migrations.ts";

const Settings = Schema.Struct({
	engine: Schema.Literal("mysql"),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.Literal("comms_schema_guard"),
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_MIGRATION_GUARD_CONFIG;
if (!filename) throw new Error("Missing disposable migration guard configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
const replacing = process.argv[2] === "replace";
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: (replacing ? "c8" : "b9").repeat(32),
};
const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
	Layer.provide(remoteInspectorLayer(options)),
);
let phase = "connect";
await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			if (replacing) {
				yield* sql`UPDATE kernel_writer SET epoch='replacement' WHERE singleton=1`;
				assert.deepEqual(yield* sql`SELECT epoch FROM kernel_writer`, [{ epoch: "replacement" }]);
				console.log("EPOCH_REPLACED");
				return;
			}
			phase = "reset";
			// This fixture runs only after the guard suite has released this exclusive disposable database.
			for (const { name } of yield* sql<{
				name: string;
			}>`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'`)
				yield* sql`DROP TABLE ${sql(name)}`;
			for (const statement of remoteAppKernelSchema(sql, settings.username)) yield* statement;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'current')`;
			yield* sql`INSERT INTO store_identity VALUES(1,'retained',1,NULL)`;
			yield* initializeRemoteKernelSchema(sql, "current");
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			for (const [id, name] of [
				[1, "first"],
				[2, "forbidden"],
			] as const)
				yield* fs.writeFileString(
					`${directory}/00${id}_${name}.ts`,
					`import{Effect}from ${JSON.stringify(import.meta.resolve("effect"))};import{SqlClient}from ${JSON.stringify(import.meta.resolve("effect/unstable/sql"))};export default Effect.gen(function*(){const sql=yield*SqlClient.SqlClient;yield*sql\`CREATE TABLE ${name}_effect(value INTEGER)\`;});`,
				);
			phase = "between-file-fence";
			const result = yield* migrate(directory, "current").pipe(Effect.exit);
			assert.equal(result._tag, "Failure");
			assert.match(JSON.stringify(result), /stale_writer/);
			assert.deepEqual(yield* sql`SELECT epoch FROM kernel_writer`, [{ epoch: "replacement" }]);
			phase = "second-file-effects";
			assert.deepEqual(
				yield* sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('first_effect','forbidden_effect') ORDER BY TABLE_NAME`,
				[{ name: "first_effect" }],
			);
			assert.deepEqual(yield* sql`SELECT scope,name,epoch FROM kernel_migration_intent`, [
				{ scope: "editable", name: "batch", epoch: "current" },
			]);
			assert.equal((yield* assertNoPendingMigration(sql).pipe(Effect.exit))._tag, "Failure");
			console.log("MIGRATION_EPOCH_PASSED");
		}),
	).pipe(Effect.provide(layer), Effect.provide(BunServices.layer)),
).catch(() => {
	throw new Error(`Migration epoch check failed at ${phase}`);
});
