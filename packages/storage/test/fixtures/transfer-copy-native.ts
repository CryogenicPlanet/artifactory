import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Effect, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { Reactivity } from "effect/unstable/reactivity";
import { on } from "../../src/dialect.ts";
import { open } from "../../src/remote-driver.ts";
import {
	copyTransferTable,
	prepareTransferTable,
	scanTransferTable,
	type TransferEngine,
	type TransferTablePlan,
} from "../../src/transfer-copy.ts";
import { transferInventory } from "../../src/transfer-inventory.ts";
import { transferJsonCanonical } from "../../src/transfer-json.ts";

const configSchema = Schema.fromJsonString(
	Schema.Struct({
		engine: Schema.Literals(["pg", "mysql"]),
		host: Schema.String,
		port: Schema.Int,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);
const engineSchema = Schema.Literals(["sqlite", "pg", "mysql"]);
const sampleSchema = Schema.Array(
	Schema.Struct({
		id: Schema.String,
		exact: Schema.String,
		body: Schema.String,
		payload: Schema.String,
		domain: Schema.NullOr(Schema.String),
		immutable: Schema.String,
	}),
);
const plan: TransferTablePlan = {
	name: "sample",
	columns: [
		{ name: "id", kind: "integer", nullable: false },
		{ name: "exact", kind: "integer", nullable: false },
		{ name: "body", kind: "text", nullable: false },
		{ name: "payload", kind: "bytes", nullable: false },
		{ name: "domain", kind: "json", nullable: true },
		{ name: "immutable", kind: "text", nullable: false },
	],
	key: ["body", "id"],
	identities: ["id"],
};

const create = (sql: SqlClient) =>
	on(sql, {
		sqlite: () =>
			sql`CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT,exact INTEGER NOT NULL,body TEXT NOT NULL,payload BLOB NOT NULL,domain TEXT,immutable TEXT NOT NULL)`,
		pg: () =>
			sql`CREATE TABLE sample(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,exact BIGINT NOT NULL,body TEXT NOT NULL,payload BYTEA NOT NULL,domain JSONB,immutable TEXT NOT NULL)`,
		mysql: () =>
			sql`CREATE TABLE sample(id BIGINT AUTO_INCREMENT PRIMARY KEY,exact BIGINT NOT NULL,body VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,payload LONGBLOB NOT NULL,domain JSON,immutable LONGTEXT CHARACTER SET utf8mb4 NOT NULL)`,
	});
interface Sample {
	readonly id: string;
	readonly exact: string;
	readonly body: string;
	readonly payload: Uint8Array;
	readonly domain: string | null;
	readonly immutable: string;
}
const insert = (sql: SqlClient, row: Sample) =>
	on(sql, {
		sqlite: () =>
			sql`INSERT INTO sample(id,exact,body,payload,domain,immutable) VALUES(CAST(${row.id} AS INTEGER),CAST(${row.exact} AS INTEGER),${row.body},${row.payload},${row.domain},${row.immutable})`,
		pg: () =>
			sql`INSERT INTO sample(id,exact,body,payload,domain,immutable) OVERRIDING SYSTEM VALUE VALUES(${row.id}::bigint,${row.exact}::bigint,${row.body},${Buffer.from(row.payload)},${row.domain}::jsonb,${row.immutable})`,
		mysql: () =>
			sql`INSERT INTO sample(id,exact,body,payload,domain,immutable) VALUES(CAST(${row.id} AS SIGNED),CAST(${row.exact} AS SIGNED),${row.body},${Buffer.from(row.payload)},${row.domain},${row.immutable})`,
	});
const samples = (sql: SqlClient) =>
	on(sql, {
		sqlite: () =>
			sql`SELECT CAST(id AS TEXT) AS id,CAST(exact AS TEXT) AS exact,body,hex(payload) AS payload,domain,immutable FROM sample ORDER BY sample.id`,
		pg: () =>
			sql`SELECT id::text AS id,exact::text AS exact,body,encode(payload,'hex') AS payload,domain::text AS domain,immutable FROM sample ORDER BY sample.id`,
		mysql: () =>
			sql`SELECT CAST(id AS CHAR) AS id,CAST(exact AS CHAR) AS exact,body,HEX(payload) AS payload,CAST(domain AS CHAR CHARACTER SET utf8mb4) AS domain,immutable FROM sample ORDER BY sample.id`,
	}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(sampleSchema)));

async function main() {
	let phase = "configuration";
	try {
		const mode = process.argv[2] ?? "";
		const sourceEngine = Schema.decodeUnknownSync(engineSchema)(process.argv[3]);
		const targetEngine = Schema.decodeUnknownSync(engineSchema)(process.argv[4]);
		const load = async (engine: "pg" | "mysql") => {
			const path =
				engine === "pg"
					? process.env.COMMS_TRANSFER_COPY_PG_CONFIG
					: mode === "packet"
						? process.env.COMMS_TRANSFER_COPY_PACKET_CONFIG
						: process.env.COMMS_TRANSFER_COPY_MYSQL_CONFIG;
			const config = Schema.decodeSync(configSchema)(await readFile(path ?? "", "utf8"));
			assert.equal(config.engine, engine);
			assert.match(config.database, /^comms_transfer_copier[a-z0-9_]*$/);
			return { ...config, password: Redacted.make(config.password), tls: false };
		};
		const pg = sourceEngine === "pg" || targetEngine === "pg" ? await load("pg") : undefined;
		const mysql = sourceEngine === "mysql" || targetEngine === "mysql" ? await load("mysql") : undefined;
		const client = (engine: TransferEngine) =>
			Effect.gen(function* () {
				if (engine === "sqlite") return yield* SqliteClient.make({ filename: ":memory:" });
				const config = engine === "pg" ? pg : mysql;
				if (!config) return yield* Effect.die("Missing fixture connection");
				return yield* open(config, `transfer-copy-${mode}`);
			});
		await Effect.runPromise(
			Effect.gen(function* () {
				phase = "open";
				const source = yield* client(sourceEngine);
				const target = yield* client(targetEngine);
				for (const sql of [source, target]) {
					assert.equal((yield* transferInventory(sql)).tables.length, 0);
					if (on(sql, { sqlite: () => false, pg: () => false, mysql: () => true })) {
						const rows = yield* sql`SELECT @@transaction_isolation AS isolation`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ isolation: Schema.String })))),
						);
						assert.equal(rows[0]?.isolation, "REPEATABLE-READ");
					}
				}
				phase = "schema";
				yield* Effect.acquireRelease(create(source), () => source`DROP TABLE sample`.pipe(Effect.orDie));
				yield* Effect.acquireRelease(create(target), () => target`DROP TABLE sample`.pipe(Effect.orDie));
				const base = 9007199254740993n;
				const bodies = ["😀", "a", "é", "A", "\ue000", "", "e\u0301", "日本語"];
				const input: Sample[] = Array.from({ length: 264 }, (_, index) => ({
					id: (base + BigInt(index)).toString(),
					exact: (-9223372036854775808n + BigInt(index)).toString(),
					body: bodies[index % bodies.length] ?? "",
					payload: index === 0 ? new Uint8Array() : new Uint8Array([0, 255, 192, 128, index]),
					domain: index === 1 ? null : index === 2 ? "null" : ` { "z":9007199254740993,"a":[1.25,"😀",${index}] } `,
					immutable: ` { "untouched": ${index}, "unicode": "é 😀" } `,
				}));
				phase = "inventory";
				const shape = (yield* transferInventory(target, [], [{ table: "sample", column: "domain" }])).tables[0];
				if (!shape) return yield* Effect.die("Missing target shape");
				phase = "seed";
				if (mode === "json-range") {
					const first = input[0];
					const last = input[1];
					if (!first || !last) return yield* Effect.die("Missing fixture samples");
					yield* insert(source, { ...first, body: "a", domain: "{}" });
					phase = "valid-prefix";
					yield* prepareTransferTable(source, target, plan, shape);
					phase = "seed";
					yield* insert(source, {
						...last,
						body: "z",
						domain: targetEngine === "pg" ? '{"n":1e200000}' : '{"n":1e400}',
					});
				} else if (mode === "packet") {
					const rows = yield* target`SELECT CAST(@@session.max_allowed_packet AS CHAR) AS packet`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ packet: Schema.String })))),
					);
					const packet = Number(rows[0]?.packet);
					assert(Number.isSafeInteger(packet) && packet >= 1024 && packet <= 65536);
					const first = input[0];
					if (!first) return yield* Effect.die("Missing fixture sample");
					yield* insert(source, { ...first, body: "a", domain: "{}" });
					phase = "valid-prefix";
					yield* prepareTransferTable(source, target, plan, shape);
					phase = "seed";
					yield* insert(source, {
						...first,
						id: (base + 1n).toString(),
						body: "z",
						payload: new Uint8Array(packet + 1),
						domain: "{}",
					});
				} else yield* source.withTransaction(Effect.forEach(input, (row) => insert(source, row), { discard: true }));
				if (mode !== "pair") {
					phase = "refusal";
					const expected = yield* scanTransferTable(source, plan, shape, targetEngine);
					const result = yield* copyTransferTable(source, target, plan, shape, expected).pipe(Effect.result);
					assert.equal(result._tag, "Failure");
					if (mode === "packet" && result._tag === "Failure")
						assert.equal(result.failure.code, "transfer_value_invalid");
					assert.equal((yield* samples(target)).length, 0);
					process.stdout.write(`verified ${mode} ${targetEngine} before writes\n`);
					return;
				}
				phase = "prepare";
				const expected = yield* prepareTransferTable(source, target, plan, shape);
				phase = "copy";
				const copied = yield* copyTransferTable(source, target, plan, shape, expected);
				assert.equal(copied.rows, input.length);
				assert.equal(copied.digest, expected.digest);
				phase = "independent-values";
				const actual = yield* samples(target);
				assert.equal(actual.length, input.length);
				for (const [index, row] of input.entries()) {
					const found = actual[index];
					assert(found);
					assert.equal(found.id, row.id);
					assert.equal(found.exact, row.exact);
					assert.equal(found.body, row.body);
					assert.equal(found.payload.toUpperCase(), Buffer.from(row.payload).toString("hex").toUpperCase());
					assert.equal(found.immutable, row.immutable);
					if (row.domain === null) assert.equal(found.domain, null);
					else {
						assert(found.domain !== null);
						assert.equal(yield* transferJsonCanonical(found.domain), yield* transferJsonCanonical(row.domain));
					}
				}
				phase = "identity-next";
				yield* target`INSERT INTO sample(exact,body,payload,domain,immutable) VALUES(1,'next',${Buffer.from([0, 255])},NULL,'next')`;
				const withNext = yield* samples(target);
				assert.equal(withNext.at(-1)?.id, (base + BigInt(input.length)).toString());
				process.stdout.write(`verified ${sourceEngine}->${targetEngine} values, stream and identity\n`);
			}).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.provide(BunCrypto.layer)),
		);
	} catch {
		throw new Error(`Native transfer fixture failed at ${phase}; driver details suppressed`);
	}
}
await main();
