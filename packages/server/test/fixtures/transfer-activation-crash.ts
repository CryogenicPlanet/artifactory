// TEST ONLY: bundled over the image CLI entry for one deterministic final-activation crash.
import { closeSync, readFileSync, writeSync } from "node:fs";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Logger, Schema } from "effect";
import { TransferFileJournal } from "@comms/storage/store-transfer-schema";
import { decodeTransferConfiguration } from "../../src/transfer/configuration.ts";
import { runTransfer } from "../../src/transfer/outer.ts";

const main = Effect.gen(function* () {
	if (process.argv.length !== 3 || process.argv[2] !== "--config-stdin")
		return yield* Effect.die("Test wrapper requires the real locked command");
	const encoded = yield* Effect.sync(() => {
		try {
			return readFileSync(0, "utf8");
		} finally {
			closeSync(0);
		}
	});
	const configuration = yield* decodeTransferConfiguration(encoded);
	if (configuration.mode !== "transfer") return yield* Effect.die("Test wrapper requires transfer mode");
	const fs = yield* FileSystem.FileSystem;
	const filename = `/data/transfers/${configuration.transferId}/journal.json`;
	const intercepted: FileSystem.FileSystem = {
		...fs,
		rename: (from, to) =>
			Effect.gen(function* () {
				if (from === `${filename}.next` && to === filename) {
					const staged = yield* fs
						.readFileString(from)
						.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TransferFileJournal))), Effect.orDie);
					if (staged.phase === "complete") {
						// Only actual runTransfer publishes complete, after its scoped workers/guardians close.
						yield* Effect.sync(() => {
							writeSync(2, "Instrumented outer checkpoint: final activation rename\n");
							process.kill(process.pid, "SIGKILL");
						});
						return yield* Effect.never;
					}
				}
				return yield* fs.rename(from, to);
			}),
	};
	yield* runTransfer(configuration).pipe(Effect.provideService(FileSystem.FileSystem, intercepted));
	return yield* Effect.die("Instrumented activation checkpoint was not reached");
}).pipe(
	Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
	Effect.provide(BunServices.layer),
);
BunRuntime.runMain(main, { disableErrorReporting: true });
