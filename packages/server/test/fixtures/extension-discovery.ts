import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Schema } from "effect";
import { discoverExtensions } from "../../src/kernel/extension-discovery.ts";

Effect.gen(function* () {
	const directory = yield* Config.String("EXTENSION_DIRECTORY");
	const entries = yield* discoverExtensions(directory);
	const result = yield* Effect.forEach(entries, (entry) =>
		entry.path.pipe(
			Effect.match({
				onSuccess: () => ({ name: entry.name, valid: true }),
				onFailure: () => ({ name: entry.name, valid: false }),
			}),
		),
	);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result));
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
