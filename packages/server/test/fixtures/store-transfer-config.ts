import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Exit } from "effect";
import { readTransferConfiguration } from "../../src/store-transfer.ts";
const main = Effect.gen(function* () {
	const result = yield* readTransferConfiguration.pipe(Effect.exit);
	assert.throws(() => fstatSync(0), { code: "EBADF" }, "Inherited config descriptor must close before any child spawn");
	if (process.env.TRANSFER_CONFIG_EXPECT === "success") {
		assert.ok(Exit.isSuccess(result));
		assert.equal(result.value.source._tag, "file");
		assert.equal(result.value.target._tag, "remote");
	} else assert.ok(Exit.isFailure(result));
	return "Configuration consumed and original descriptor closed";
}).pipe(Effect.provide(BunServices.layer));
BunRuntime.runMain(main.pipe(Effect.flatMap(Console.log)));
