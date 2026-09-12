import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { SqlError } from "effect/unstable/sql";
import { transferStage } from "../../src/transfer/worker.ts";
const main = Effect.gen(function* () {
	for (const driver of [
		{ code: "42501", message: "postgres://user:fixture-secret@host/db", sql: "SELECT fixture-secret" },
		{ sqlState: "42000", errno: 1142, message: "mysql://user:fixture-secret@host/db" },
		{ code: "fixture-secret", errno: NaN, message: "fixture-secret" },
	])
		yield* Effect.fail(
			new SqlError.SqlError({ reason: new SqlError.AuthorizationError({ cause: driver, message: "fixture-secret" }) }),
		).pipe(transferStage("source_inspection"), Effect.exit);
	yield* Console.log("Safe SQL diagnostics verified");
});
BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
