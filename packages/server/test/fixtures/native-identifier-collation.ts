import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { initializeRemoteBootSchema } from "../../../boot/src/remote-boot-schema.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.Literals(["comms_collation_boot", "comms_collation_fixed_boot"]),
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_COLLATION_CONFIG;
if (!filename) throw new Error("Missing disposable collation configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
const client = guardianClientLayer({
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "d".repeat(64),
	register: () => Effect.void,
});
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		process.stdout.write("initialize\n");
		yield* initializeRemoteBootSchema(sql, settings.engine);
		process.stdout.write("case_and_accent_distinct_ids\n");
		for (const id of ["Case", "case", "café", "cafe"]) {
			yield* sql`INSERT INTO source_batches(id,agent,at,state) VALUES (${id},'agent',1,'published')`;
			assert.deepEqual(yield* sql`SELECT id FROM source_batches WHERE id=${id}`, [{ id }]);
		}
		assert.equal((yield* sql`SELECT id FROM source_batches`).length, 4);
		yield* initializeRemoteBootSchema(sql, settings.engine);
		if (settings.engine === "mysql") {
			// lock_id is an identifier without incoming foreign keys; changing its
			// collation must succeed independently of duplicate-key/FK enforcement.
			process.stdout.write("alter_identifier_collation\n");
			yield* sql`ALTER TABLE source_batches MODIFY lock_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL`;
			const altered =
				yield* sql`SELECT COLLATION_NAME AS collation FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='source_batches' AND COLUMN_NAME='lock_id'`;
			assert.equal(altered[0]?.collation, "utf8mb4_0900_ai_ci");
			process.stdout.write("reject_altered_collation\n");
			const reopened = yield* initializeRemoteBootSchema(sql, settings.engine).pipe(Effect.result);
			assert.equal(reopened._tag, "Failure", "Accent-insensitive identifier store was accepted on reopen");
			if (reopened._tag === "Failure") {
				assert.equal(reopened.failure._tag, "SchemaShapeError");
				assert.ok("object" in reopened.failure);
				assert.equal(reopened.failure.object, "source_batches");
			}
		}
	}).pipe(Effect.provide(client), Effect.provide(BunServices.layer), Effect.scoped),
);
