import { BunCrypto } from "@effect/platform-bun";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "../../src/client.ts";
import { copyTransferTable, scanTransferTable, type TransferTablePlan } from "../../src/transfer-copy.ts";
import { transferInventory } from "../../src/transfer-inventory.ts";

const root = process.argv[2];
const mode = process.argv[3];
if (!root) throw new Error("Missing fixture directory");

await Effect.runPromise(
	Effect.gen(function* () {
		const source = Context.get(
			yield* Layer.build(clientLayer({ _tag: "file", filename: `${root}/source.db` })),
			SqlClient.SqlClient,
		);
		const target = Context.get(
			yield* Layer.build(clientLayer({ _tag: "file", filename: `${root}/target.db` })),
			SqlClient.SqlClient,
		);
		const invalidKey = mode === "duplicate-key" || mode === "null-key";
		if (invalidKey)
			yield* source`CREATE TABLE items(id INTEGER,exact INTEGER NOT NULL,body TEXT NOT NULL,payload BLOB NOT NULL,meta TEXT,optional TEXT,weight REAL NOT NULL)`;
		else
			yield* source`CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,exact INTEGER NOT NULL,body TEXT NOT NULL,payload BLOB NOT NULL,meta TEXT,optional TEXT,weight REAL NOT NULL)`;
		if (mode === "null-target")
			yield* target`CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,exact INTEGER NOT NULL,body TEXT NOT NULL,payload BLOB NOT NULL,meta TEXT,optional TEXT NOT NULL,weight REAL NOT NULL)`;
		else
			yield* target`CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,exact INTEGER NOT NULL,body TEXT NOT NULL,payload BLOB NOT NULL,meta TEXT,optional TEXT,weight REAL NOT NULL)`;

		const plan: TransferTablePlan = {
			name: "items",
			columns: [
				{ name: "id", kind: "integer", nullable: false },
				{ name: "exact", kind: "integer", nullable: false },
				{ name: "body", kind: "text", nullable: false },
				{ name: "payload", kind: "bytes", nullable: false },
				{ name: "meta", kind: "json", nullable: true },
				{ name: "optional", kind: "text", nullable: true },
				{ name: "weight", kind: "real", nullable: false },
			],
			key: mode === "no-key" ? [] : ["id"],
			identities: ["id"],
		};
		const expectedSample = (index: number) => ({
			id: index.toString(),
			exact: "9223372036854775807",
			body: `日本語😀é row ${index}`,
			payload: `00FFC080${(index % 256).toString(16).padStart(2, "0").toUpperCase()}`,
			meta: '{"n":9007199254740993,"a":[null,"😀",1.25]}',
			optional: index === 513 ? null : `optional ${index}`,
			weight: index + 0.25,
		});
		yield* source.withTransaction(
			Effect.gen(function* () {
				for (let index = 1; index <= 513; index++) {
					const sample = expectedSample(index);
					const key = index === 513 && invalidKey ? (mode === "null-key" ? null : 1) : index;
					yield* source`INSERT INTO items(id,exact,body,payload,meta,optional,weight) VALUES(${key},CAST(${sample.exact} AS INTEGER),${sample.body},${new Uint8Array([0, 255, 192, 128, index % 256])},${sample.meta},${sample.optional},${sample.weight})`;
				}
			}),
		);
		const targetShape = (yield* transferInventory(target, [], [{ table: "items", column: "meta" }])).tables[0];
		if (!targetShape) return yield* Effect.die("Missing fixture target table");
		const result = yield* Effect.gen(function* () {
			if (invalidKey || mode === "no-key") return yield* scanTransferTable(source, plan, targetShape, "sqlite");
			const sourceShape = (yield* transferInventory(source, [], [{ table: "items", column: "meta" }])).tables[0];
			if (!sourceShape) return yield* Effect.die("Missing fixture source table");
			const expected = yield* scanTransferTable(source, plan, sourceShape, "sqlite");
			if (mode === "nonempty")
				yield* target`INSERT INTO items(id,exact,body,payload,meta,optional,weight) VALUES(999,1,'existing target row',${new Uint8Array([9])},NULL,NULL,1.0)`;
			return yield* copyTransferTable(
				source,
				target,
				plan,
				targetShape,
				mode === "wrong-digest" ? { ...expected, digest: "0".repeat(64) } : expected,
			);
		}).pipe(Effect.result);
		const counts = yield* target`SELECT COUNT(*) AS count FROM items`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })))),
		);
		if (mode === "copy" && result._tag === "Success") {
			const scanned = yield* scanTransferTable(target, plan, targetShape, "sqlite");
			const samples =
				yield* target`SELECT CAST(id AS TEXT) AS id,CAST(exact AS TEXT) AS exact,body,hex(payload) AS payload,meta,optional,weight FROM items WHERE id IN (1,256,257,512,513) ORDER BY id`;
			yield* target`UPDATE items SET payload=${new Uint8Array([0, 255, 192, 128, 99])} WHERE id=257`;
			const corrupted = yield* scanTransferTable(target, plan, targetShape, "sqlite");
			process.stdout.write(
				JSON.stringify({
					result: { _tag: result._tag, success: result.success },
					count: counts[0]?.count,
					manifestMatches: JSON.stringify(scanned) === JSON.stringify(result.success),
					samplesMatch: JSON.stringify(samples) === JSON.stringify([1, 256, 257, 512, 513].map(expectedSample)),
					corruptionDetected: corrupted.rows === scanned.rows && corrupted.digest !== scanned.digest,
				}),
			);
		} else {
			const retained = yield* target`SELECT CAST(id AS TEXT) AS id,body,hex(payload) AS payload FROM items ORDER BY id`;
			process.stdout.write(
				JSON.stringify({
					result:
						result._tag === "Success"
							? { _tag: result._tag, success: result.success }
							: { _tag: result._tag, failure: result.failure },
					count: counts[0]?.count,
					retained,
				}),
			);
		}
	}).pipe(Effect.scoped, Effect.provide(BunCrypto.layer)),
);
