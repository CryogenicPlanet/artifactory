import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

const main = Effect.gen(function* () {
	for (const filename of process.argv.slice(2)) {
		const context = yield* Layer.build(SqliteClient.layer({ filename }));
		const sql = Context.get(context, SqlClient.SqlClient);
		yield* sql`PRAGMA synchronous=FULL`;
		yield* sql`UPDATE kernel_writer SET epoch='committed-in-wal'`;
	}
	yield* Console.log("ready");
	return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
BunRuntime.runMain(main);
