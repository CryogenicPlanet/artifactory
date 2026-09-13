import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { Effect, Exit, Redacted, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { advisoryClientLayer } from "../../src/remote-client.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const filename = process.env.COMMS_REMOTE_TEST_CONFIG;
if (!filename || process.env.COMMS_REMOTE_TEST_MODE !== "leases")
	throw new Error("Missing disposable leases configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
const layer = advisoryClientLayer({
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
});
try {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient;
			yield* sql`CREATE TABLE remote_probe_leases(value INTEGER)`;
			yield* sql`INSERT INTO remote_probe_leases VALUES(1)`;
			yield* sql.withTransaction(sql`INSERT INTO remote_probe_leases VALUES(2)`);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const reserved = yield* sql.reserve;
					yield* reserved.executeUnprepared("INSERT INTO remote_probe_leases VALUES(3)", [], undefined);
				}),
			);
			assert.deepEqual(
				yield* sql`SELECT value FROM remote_probe_leases ORDER BY value`.stream.pipe(Stream.runCollect),
				[{ value: 1 }, { value: 2 }, { value: 3 }],
			);
			const rollback = yield* sql
				.withTransaction(
					sql`INSERT INTO remote_probe_leases VALUES(4)`.pipe(Effect.andThen(Effect.fail("rollback probe"))),
				)
				.pipe(Effect.exit);
			assert(Exit.isFailure(rollback));
			assert.equal((yield* sql`SELECT value FROM remote_probe_leases`).length, 3);
			const safe =
				settings.engine === "pg"
					? "SELECT 9007199254740991::bigint AS n"
					: "SELECT CAST(9007199254740991 AS SIGNED) AS n";
			const unsafe =
				settings.engine === "pg"
					? "SELECT 9007199254740992::bigint AS n"
					: "SELECT CAST(9007199254740992 AS SIGNED) AS n";
			assert.deepEqual(yield* sql.unsafe(safe), [{ n: Number.MAX_SAFE_INTEGER }]);
			assert.deepEqual(yield* sql.unsafe(safe).values, [[Number.MAX_SAFE_INTEGER]]);
			assert.deepEqual(yield* sql.unsafe(safe).stream.pipe(Stream.runCollect), [{ n: Number.MAX_SAFE_INTEGER }]);
			for (const query of [
				sql.unsafe(unsafe),
				sql.unsafe(unsafe).values,
				sql.unsafe(unsafe).raw,
				sql.unsafe(unsafe).stream.pipe(Stream.runCollect),
			]) {
				const result = yield* query.pipe(Effect.exit);
				assert(Exit.isFailure(result), "Unsafe integer escaped SQL client");
				assert(!JSON.stringify(result).includes(settings.password));
			}
		}).pipe(Effect.provide(layer), Effect.scoped),
	);
	process.stdout.write(JSON.stringify({ mode: "leases", passed: true }));
} catch {
	throw new Error("Remote SQL access path acceptance failed");
}
