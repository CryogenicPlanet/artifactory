import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { RemoteTransferConfiguration } from "@comms/boot";
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { decodeTransferConfiguration } from "./transfer/configuration.ts";
import { runStoreTransferWorker } from "./transfer/worker.ts";
const main = Effect.gen(function* () {
	const input = yield* Config.Redacted("COMMS_TRANSFER_INPUT");
	const owners = yield* Config.Redacted("COMMS_REMOTE_TRANSFER_CONFIG");
	const configuration = yield* decodeTransferConfiguration(Redacted.value(input));
	const ownership = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteTransferConfiguration))(
		Redacted.value(owners),
	);
	yield* runStoreTransferWorker(configuration, ownership);
}).pipe(
	Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
	Effect.onError(() => Console.error("Offline transfer worker failed; target remains ineligible.")),
);
if (import.meta.main) BunRuntime.runMain(main, { disableErrorReporting: true });
