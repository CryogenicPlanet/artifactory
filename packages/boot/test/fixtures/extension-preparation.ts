import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { GenerationPreparation, layer } from "../../src/generation-preparation.ts";
import { layer as processLayer } from "../../src/preparation-process.ts";
import { copySource } from "../../src/snapshots.ts";

const main = Effect.gen(function* () {
	const [source, snapshot, dataDirectory] = process.argv.slice(2);
	if (!source || !snapshot || !dataDirectory) throw new Error("Expected source, snapshot, data directory");
	yield* copySource(source, snapshot);
	const preparation = yield* GenerationPreparation.pipe(Effect.provide(layer({ dataDirectory })));
	const result = yield* preparation.prepare(source, snapshot).pipe(Effect.result);
	process.stdout.write(
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(
			result._tag === "Success" ? { prepared: true } : { prepared: false, error: result.failure._tag },
		),
	);
}).pipe(Effect.scoped, Effect.provide(processLayer.pipe(Layer.provideMerge(BunServices.layer))));
main.pipe(BunRuntime.runMain);
