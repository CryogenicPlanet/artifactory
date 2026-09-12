import assert from "node:assert/strict";
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Redacted } from "effect";
import { decodeTransferConfiguration, encodeTransferConfiguration } from "../../src/transfer/configuration.ts";
const main = Effect.gen(function* () {
	const password = "fixture @:/%雪";
	const credentials = encodeURIComponent(password);
	for (const source of [
		{ boot: "file:/data/boot.db", app: "file:/data/store/comms.db" },
		{
			boot: `mysql://boot:${credentials}@localhost:3307/source_boot`,
			app: `mysql://app:${credentials}@localhost:3307/source_app`,
		},
	]) {
		const original = yield* decodeTransferConfiguration(
			JSON.stringify({
				version: 1,
				transfer_id: "22222222-2222-4222-8222-222222222222",
				mode: "transfer",
				tls: false,
				source,
				target: {
					boot: `postgres://boot:${credentials}@[::1]:5433/target_boot`,
					app: `postgres://app:${credentials}@[::1]:5433/target_app`,
				},
			}),
		);
		const encoded = yield* encodeTransferConfiguration(original);
		assert.ok(!String(encoded).includes(password));
		const decoded = yield* decodeTransferConfiguration(Redacted.value(encoded));
		assert.equal(decoded.transferId, original.transferId);
		assert.equal(decoded.mode, original.mode);
		assert.equal(decoded.source._tag, original.source._tag);
		assert.equal(decoded.target._tag, "remote");
		if (decoded.target._tag !== "remote") return yield* Effect.die("Expected remote target");
		assert.equal(decoded.target.bootConnection.host, "::1");
		assert.equal(decoded.target.bootConnection.port, 5433);
		assert.equal(decoded.target.bootConnection.tls, false);
		assert.equal(Redacted.value(decoded.target.bootConnection.password), password);
		assert.equal(Redacted.value(decoded.target.appConnection.password), password);
	}
	return "Protected configuration round trip verified";
});
BunRuntime.runMain(main.pipe(Effect.flatMap(Console.log)));
