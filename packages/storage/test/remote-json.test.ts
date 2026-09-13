import { readFile } from "node:fs/promises";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { advisoryClientLayer } from "../src/remote-client.ts";
import { Effect, Redacted, Schema, Stream } from "effect";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_PG_JSON_TEST_CONFIG)(
	"returns raw JSON text through native PostgreSQL result paths",
	async () => {
		const filename = process.env.COMMS_PG_JSON_TEST_CONFIG;
		if (!filename) throw new Error("Missing PostgreSQL codec fixture configuration");
		const config = await readFile(filename, "utf8")
			.then((input) =>
				Schema.decodeSync(
					Schema.fromJsonString(
						Schema.Struct({
							host: Schema.String,
							port: Schema.Int,
							database: Schema.String,
							username: Schema.String,
							password: Schema.String,
						}),
					),
				)(input),
			)
			.catch(() => {
				throw new Error("Invalid PostgreSQL codec fixture configuration");
			});
		const options = {
			connection: { ...config, engine: "pg" as const, password: Redacted.make(config.password), tls: false },
		};
		const layer = advisoryClientLayer(options);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient;
				const source = ' { "n":9007199254740993, "text":"雪 🐘", "escaped":"\\u0061\\n" } ';
				const query = `SELECT $1::json AS j, $1::jsonb AS b, ($1::jsonb)::text AS expected, NULL::json AS absent, 'null'::jsonb AS literal`;
				const rows = yield* sql.unsafe<{ j: string; b: string; expected: string; absent: null; literal: string }>(
					query,
					[source],
				);
				const row = rows[0];
				expect(row?.j).toBe(source);
				expect(row?.b).toBe(row?.expected);
				expect(row?.b).toContain("9007199254740993");
				expect(row?.absent).toBe(null);
				expect(row?.literal).toBe("null");
				const values = yield* sql.unsafe(query, [source]).values;
				expect(values).toEqual([[source, row?.expected, row?.expected, null, "null"]]);
				expect(yield* sql.unsafe(query, [source]).stream.pipe(Stream.runCollect)).toEqual(rows);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const connection = yield* sql.reserve;
						expect(yield* connection.executeUnprepared(query, [source], undefined)).toEqual(rows);
					}),
				);
				const arrays = yield* sql`SELECT ARRAY[${source}::json,NULL::json] AS items`;
				expect(arrays).toEqual([{ items: [source, null] }]);
			}).pipe(Effect.scoped, Effect.provide(layer)),
		).catch(() => {
			throw new Error("Native PostgreSQL JSON codec acceptance failed");
		});
	},
);
