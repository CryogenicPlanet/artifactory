import { BunRuntime } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SELECT count(*) FROM events`;
			yield* Console.log("ready");
			return yield* Effect.never;
		}),
	);
}).pipe(Effect.provide(SqliteClient.layer({ filename: process.argv[2] ?? "", readonly: true })), BunRuntime.runMain);
