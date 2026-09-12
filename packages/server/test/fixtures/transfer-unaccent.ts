import { BunServices } from "@effect/platform-bun";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Effect, Layer, Redacted, Schema, Result } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { transferInventory } from "@comms/storage/transfer-inventory";
import { prepareTransferTable, copyTransferTable } from "@comms/storage/transfer-copy";
import { postgresSearchDeclarations } from "../../src/transfer/search-capability.ts";
import { logicalTransferPlan } from "../../src/transfer/logical-plan.ts";
import { coreJsonColumns } from "../../src/transfer/derived-schema.ts";
const settings = Schema.fromJsonString(
	Schema.Struct({
		engine: Schema.Literal("pg"),
		host: Schema.String,
		port: Schema.Int,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);
const from = Schema.decodeSync(settings)(await readFile(process.env.COMMS_UNACCENT_SOURCE_CONFIG ?? "", "utf8"));
const to = Schema.decodeSync(settings)(await readFile(process.env.COMMS_UNACCENT_TARGET_CONFIG ?? "", "utf8"));
assert(from.database.startsWith("comms_schema_unaccent"));
assert(to.database.startsWith("comms_schema_unaccent"));
assert.notEqual(from.database, to.database);
const layer = (s: typeof settings.Type, attempt: string) => {
	const options = { connection: { ...s, password: Redacted.make(s.password), tls: false }, attempt };
	return remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
		Layer.provide(remoteInspectorLayer(options)),
	);
};
let phase = "catalog";
try {
	await Effect.runPromise(
		Effect.gen(function* () {
			const source = yield* SqlClient;
			yield* Effect.gen(function* () {
				const target = yield* SqlClient;
				const inventory = (sql: SqlClient) =>
					Effect.gen(function* () {
						return yield* transferInventory(sql, yield* postgresSearchDeclarations(sql), coreJsonColumns);
					});
				const sourceInventory = yield* inventory(source);
				const targetInventory = yield* inventory(target);
				const plan = yield* logicalTransferPlan({
					store: "app",
					source: { engine: "pg", inventory: sourceInventory },
					target: { engine: "pg", inventory: targetInventory },
				});
				const message = plan.tables.find((t) => t.name === "messages");
				const shape = targetInventory.tables.find((t) => t.name === "messages");
				assert(message && shape);
				assert(!message.columns.some((c) => c.name.endsWith("_tsv")));
				phase = "copy";
				// Disposable fixture only; target is restored by its enclosing rollback even if assertions fail.
				const result = yield* target
					.withTransaction(
						Effect.gen(function* () {
							yield* target`DELETE FROM messages`;
							const manifest = yield* prepareTransferTable(source, target, message, shape);
							yield* copyTransferTable(source, target, message, shape, manifest);
							assert.deepEqual(
								yield* source`SELECT id,body,previous FROM messages ORDER BY id`,
								yield* target`SELECT id,body,previous FROM messages ORDER BY id`,
							);
							const rows =
								yield* target`SELECT id FROM messages WHERE body_tsv @@ plainto_tsquery('simple',public.comms_unaccent('résumé'))`;
							assert.deepEqual(rows, [{ id: "current" }]);
							return yield* Effect.fail("restore_fixture");
						}),
					)
					.pipe(Effect.result);
				assert(Result.isFailure(result));
				assert.equal(result.failure, "restore_fixture");
				phase = "unknown_function";
				const denied = yield* source
					.withTransaction(
						Effect.gen(function* () {
							yield* source`CREATE FUNCTION public.unrelated_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'`;
							assert(Result.isFailure(yield* inventory(source).pipe(Effect.result)));
							return yield* Effect.fail("restore_function");
						}),
					)
					.pipe(Effect.result);
				assert(Result.isFailure(denied));
				assert.equal(denied.failure, "restore_function");
			}).pipe(Effect.provide(layer(to, "d2".repeat(32))), Effect.scoped);
		}).pipe(Effect.provide(layer(from, "d1".repeat(32))), Effect.provide(BunServices.layer), Effect.scoped),
	);
	process.stdout.write("Unaccent transfer catalog and regenerated copy passed\n");
} catch {
	throw new Error(`Unaccent transfer failed during ${phase}`);
}
