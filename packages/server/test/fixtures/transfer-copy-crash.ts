// TEST ONLY: build-time import adapter for the real worker's transfer data plan.
import { writeSync } from "node:fs";
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { copyTransferTable as actualCopy } from "@comms/storage/transfer-copy";
export { prepareTransferTable, scanTransferTable } from "@comms/storage/transfer-copy";
export type { TransferTableManifest } from "@comms/storage/transfer-copy";

export const copyTransferTable: typeof actualCopy = (source, target, plan, shape, expected) => {
	if (plan.name !== "messages") return actualCopy(source, target, plan, shape, expected);
	const withTransaction: SqlClient["withTransaction"] = (effect) =>
		Effect.gen(function* () {
			if (Option.isSome(yield* Effect.serviceOption(target.transactionService)))
				return yield* target.withTransaction(effect);
			const result = yield* target.withTransaction(effect);
			yield* Effect.sync(() => {
				writeSync(2, "Instrumented worker checkpoint: messages table committed\n");
				process.kill(process.pid, "SIGKILL");
			});
			return result;
		});
	// Preserve the actual callable guarded client; change only this invocation's transaction boundary.
	const intercepted = new Proxy(target, {
		get: (object, key, receiver) => (key === "withTransaction" ? withTransaction : Reflect.get(object, key, receiver)),
	});
	return Effect.gen(function* () {
		if (expected.rows < 1 || Option.isSome(yield* Effect.serviceOption(target.transactionService)))
			return yield* Effect.die("Copy checkpoint requires a nonempty, independently committed messages table");
		return yield* actualCopy(source, intercepted, plan, shape, expected);
	});
};
