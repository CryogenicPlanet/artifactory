import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { withDatabase } from "@comms/storage/store";
import { databaseConfiguration, launchRemoteRoot, remoteRuntime } from "../../../boot/src/index.ts";

// Deliberate operator damage is restricted to a dedicated fixture pair, with the
// real guardian's inventory admission proving the previous board was closed.
const program = Effect.gen(function* () {
	const root = yield* Config.String("DATA_DIR");
	const action = yield* Config.String("REPAIR_ACTION");
	assert.ok(["inspect", "missing", "foreign", "pending"].includes(action));
	const config = yield* databaseConfiguration(`${root}/boot.db`, `${root}/comms.db`);
	if (config._tag !== "remote") return yield* Effect.die("Expected disposable remote pair");
	assert.match(config.boot.database, /^comms_repair_[a-z]+_boot$/);
	assert.match(config.app.database, /^comms_repair_[a-z]+_app$/);
	const parent = yield* Config.Redacted("COMMS_REMOTE_ROOT_CONFIG").pipe(Config.withDefault(undefined));
	if (parent === undefined) {
		const exit = yield* Effect.scoped(
			launchRemoteRoot(config, { dataDirectory: root, entry: fileURLToPath(import.meta.url), env: {} }),
		);
		assert.equal(Number(exit), 0);
		return;
	}
	const runtime = yield* remoteRuntime(config, root);
	const sql = runtime.bootSql;
	const settings =
		yield* sql`SELECT ${sql("key")},value FROM settings WHERE ${sql("key")} IN ('app_store_database','app_store_id') ORDER BY ${sql("key")}`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
			),
		);
	const selected = settings.find((row) => row.key === "app_store_database")?.value;
	assert.ok(selected);
	assert.ok(selected === config.app.database || /^comms_app_[a-f0-9]{32}$/.test(selected));
	const store = yield* withDatabase(config.app, selected);
	if (action === "missing") {
		assert.equal(selected, config.app.database, "Only the initial dedicated fixture DB may be removed");
		yield* sql`DROP DATABASE ${sql(selected)}`;
	} else if (action === "foreign" || action === "pending") {
		yield* runtime.withStore(
			store,
			Effect.gen(function* () {
				const app = yield* SqlClient.SqlClient;
				yield* app`UPDATE store_identity SET store_id='99999999-9999-4999-8999-999999999999' WHERE singleton=1`;
			}),
		);
		if (action === "pending")
			yield* sql`UPDATE seq SET pending_id='repair-unresolved',pending_attempt='repair-prior',pending_from=${sql("next")},pending_to=${sql("next")},${sql("next")}=${sql("next")}+1 WHERE singleton=1`;
	}
	const readEvidence = (database: string) =>
		Effect.gen(function* () {
			const exists =
				config.boot._tag === "postgres"
					? yield* sql`SELECT datname FROM pg_database WHERE datname=${database}`
					: yield* sql`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${database}`;
			if (exists.length === 0) return null;
			return yield* runtime.withStore(
				yield* withDatabase(config.app, database),
				Effect.gen(function* () {
					const app = yield* SqlClient.SqlClient;
					return {
						identity: yield* app`SELECT store_id FROM store_identity WHERE singleton=1`,
						messages: yield* app`SELECT id,body FROM messages ORDER BY id`,
					};
				}),
			);
		});
	const evidence = yield* readEvidence(selected);
	const original = selected === config.app.database ? evidence : yield* readEvidence(config.app.database);
	const pending = yield* sql`SELECT pending_id,pending_attempt,pending_from,pending_to FROM seq WHERE singleton=1`;
	const restores = yield* sql`SELECT proof_id,phase FROM db_restore_requests ORDER BY proof_id`;
	const generationErrors = yield* sql`SELECT stderr FROM generations WHERE stderr IS NOT NULL`;
	const sequence = yield* sql`SELECT next,published_through FROM seq`;
	const children = yield* sql`SELECT closed FROM child_attempts`;
	console.log(
		JSON.stringify({ selected, settings, evidence, original, pending, restores, generationErrors, sequence, children }),
	);
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause(() => Effect.die("Private repair operator failed; credentials omitted")),
	BunRuntime.runMain,
);
