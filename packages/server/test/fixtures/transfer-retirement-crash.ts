// TEST ONLY: intercept the real coordinator's source-boot retirement commit.
import { writeSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { bindingText } from "@comms/storage/store-transfer-schema";
import { transferStores as actualTransfer } from "../../src/store-transfer-coordinator.ts";

export const transferStores: typeof actualTransfer = (binding, stores) => {
	const source = stores.sourceBoot;
	const withTransaction: SqlClient["withTransaction"] = (effect) =>
		Effect.gen(function* () {
			if (Option.isSome(yield* Effect.serviceOption(source.transactionService)))
				return yield* source.withTransaction(effect);
			const result = yield* source.withTransaction(effect);
			const boot = yield* source`SELECT value FROM settings WHERE ${source("key")}='transferred_to'`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
				Effect.orDie,
			);
			const app = yield* stores.sourceApp`SELECT transferred_to FROM store_identity WHERE singleton=1`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ transferred_to: Schema.Null })))),
				Effect.orDie,
			);
			if (boot.length !== 1 || boot[0]?.value !== bindingText(binding) || app.length !== 1)
				return yield* Effect.die("Retirement checkpoint binding not established");
			yield* Effect.sync(() => {
				writeSync(2, "Instrumented worker checkpoint: source boot retired, app unretired\n");
				process.kill(process.pid, "SIGKILL");
			});
			return result;
		});
	const intercepted = new Proxy(source, {
		get: (object, key, receiver) => (key === "withTransaction" ? withTransaction : Reflect.get(object, key, receiver)),
	});
	return actualTransfer(binding, { ...stores, sourceBoot: intercepted });
};
