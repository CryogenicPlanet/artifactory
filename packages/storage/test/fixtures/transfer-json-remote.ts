import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Effect, Redacted, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { open } from "../../src/remote-driver.ts";
import { transferInventory } from "../../src/transfer-inventory.ts";
import { decodeTransferValue, digestTransferRows } from "../../src/transfer-values.ts";

async function main() {
	const settings = Schema.decodeSync(
		Schema.fromJsonString(
			Schema.Struct({
				engine: Schema.Literals(["pg", "mysql"]),
				host: Schema.String,
				port: Schema.Int,
				database: Schema.String,
				username: Schema.String,
				password: Schema.String,
			}),
		),
	)(await readFile(process.env.COMMS_TRANSFER_JSON_TEST_CONFIG ?? "", "utf8"));
	assert(/^comms_transfer_[a-z0-9_]+$/.test(settings.database));
	await Effect.runPromise(
		Effect.gen(function* () {
			const remote = yield* open(
				{ ...settings, password: Redacted.make(settings.password), tls: false },
				"transfer-json-fixture",
			);
			const sqlite = yield* SqliteClient.make({ filename: ":memory:" });
			assert.equal((yield* transferInventory(remote)).tables.length, 0);
			const pg = settings.engine === "pg";
			if (pg) yield* remote`CREATE TABLE sample(id INTEGER PRIMARY KEY, domain JSONB, custom JSONB, immutable TEXT)`;
			else yield* remote`CREATE TABLE sample(id INTEGER PRIMARY KEY, domain JSON, custom JSON, immutable LONGTEXT)`;
			try {
				const policy = [{ table: "sample", column: "domain" }];
				assert.equal(
					(yield* transferInventory(remote)).tables[0]?.columns.find((column) => column.name === "domain")?.kind,
					"unsupported",
				);
				const columns = (yield* transferInventory(remote, [], policy)).tables[0]?.columns;
				assert.equal(columns?.find((column) => column.name === "domain")?.kind, "json");
				assert.equal(columns?.find((column) => column.name === "custom")?.kind, "unsupported");
				assert.equal(columns?.find((column) => column.name === "immutable")?.kind, "text");
				for (const selected of [
					[{ table: "sample", column: "id" }],
					[{ table: "sample", column: "missing" }],
					[...policy, ...policy],
				])
					assert.equal((yield* transferInventory(remote, [], selected).pipe(Effect.result))._tag, "Failure");
				const source = ' {"z": 9007199254740993, "a": ["雪 🐘", 1.00, null], "escaped": "\\u0061"} ';
				if (pg)
					yield* remote`INSERT INTO sample VALUES(1,${source}::jsonb,NULL,${source}),(2,'null'::jsonb,NULL,${source}),(3,NULL,NULL,${source})`;
				else
					yield* remote`INSERT INTO sample VALUES(1,${source},NULL,${source}),(2,'null',NULL,${source}),(3,NULL,NULL,${source})`;
				const rows = yield* (
					pg
						? remote`SELECT id,domain::text AS domain,immutable FROM sample ORDER BY id`
						: remote`SELECT id,CAST(domain AS CHAR CHARACTER SET utf8mb4) AS domain,immutable FROM sample ORDER BY id`
				).pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(
								Schema.Struct({ id: Schema.Int, domain: Schema.NullOr(Schema.String), immutable: Schema.String }),
							),
						),
					),
				);
				yield* sqlite`CREATE TABLE sample(id INTEGER PRIMARY KEY, domain TEXT, immutable TEXT)`;
				assert.equal(
					(yield* transferInventory(sqlite, [], policy)).tables[0]?.columns.find((column) => column.name === "domain")
						?.kind,
					"json",
				);
				const sourceCells = [];
				for (const row of rows) {
					const json = yield* decodeTransferValue("json", row.domain);
					const immutable = yield* decodeTransferValue("text", row.immutable);
					sourceCells.push([json, immutable]);
					yield* sqlite`INSERT INTO sample VALUES(${row.id},${json.value},${immutable.value})`;
				}
				const target = yield* sqlite`SELECT domain,immutable FROM sample ORDER BY id`;
				const targetCells = [];
				for (const row of target)
					targetCells.push([
						yield* decodeTransferValue("json", row.domain),
						yield* decodeTransferValue("text", row.immutable),
					]);
				assert.equal(yield* digestTransferRows(sourceCells), yield* digestTransferRows(targetCells));
				assert.deepEqual(
					target.map((row) => row.immutable),
					[source, source, source],
				);
				assert.equal(rows[1]?.domain, "null");
				assert.equal(rows[2]?.domain, null);
				assert.equal(
					yield* digestTransferRows([[yield* decodeTransferValue("json", rows[0]?.domain)]]),
					yield* digestTransferRows([[yield* decodeTransferValue("json", source)]]),
				);
				process.stdout.write(`verified ${settings.engine} JSON projection\n`);
			} finally {
				yield* remote`DROP TABLE sample`;
			}
		}).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.provide(BunCrypto.layer)),
	);
}
await main().catch(() => {
	throw new Error("Transfer JSON native fixture failed; details suppressed");
});
