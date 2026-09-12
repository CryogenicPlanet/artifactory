import { BunRuntime, BunServices } from "@effect/platform-bun";
import { runTransfer } from "./transfer/outer.ts";
import { closeSync } from "node:fs";
import { decodeTransferConfiguration } from "./transfer/configuration.ts";
import { Console, Effect, Logger, Stdio, Stream } from "effect";
import { TransferRejected } from "@comms/storage/store-transfer-schema";

const invalid = () => new TransferRejected({ code: "transfer_binding_invalid" });

// Stdio owns reads but exposes no close operation. This narrow native lifecycle bridge
// closes the inherited secret descriptor before any guardian or editable worker exists.
const closeConfigurationInput = Effect.callback<void>((resume) => {
	const input = process.stdin;
	if (input.closed) return resume(Effect.void);
	const closed = () => resume(Effect.void);
	input.once("close", closed);
	input.destroy();
	return Effect.sync(() => input.off("close", closed));
}).pipe(
	Effect.timeout("5 seconds"),
	Effect.andThen(
		Effect.try({
			try: () => {
				// Standard input streams may use autoClose:false. Destroying the stream alone
				// is not evidence that the inherited secret file descriptor is gone.
				try {
					closeSync(0);
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
				}
			},
			catch: invalid,
		}),
	),
	Effect.orDie,
);

/** Only the root image wrapper opens --config. Its validated root-owned 0600 file is
 * inherited as stdin; credentials never appear in arguments, diagnostics or receipt files. */
export const readTransferConfiguration = Effect.gen(function* () {
	const encoded = yield* Effect.scoped(
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() => closeConfigurationInput);
			if (process.argv.length !== 3 || process.argv[2] !== "--config-stdin") return yield* invalid();
			const stdio = yield* Stdio.Stdio;
			const chunks = yield* stdio.stdin.pipe(
				Stream.runFoldEffect(
					() => ({ size: 0, chunks: [] as readonly Uint8Array[] }),
					(state, chunk) =>
						state.size + chunk.length > 65_536
							? Effect.fail(invalid())
							: Effect.succeed({ size: state.size + chunk.length, chunks: [...state.chunks, chunk] }),
				),
			);
			const bytes = new Uint8Array(chunks.size);
			let offset = 0;
			for (const chunk of chunks.chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			return yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes), catch: invalid });
		}),
	);
	return yield* decodeTransferConfiguration(encoded);
});

if (import.meta.main) {
	const main = readTransferConfiguration.pipe(
		Effect.flatMap(runTransfer),
		Effect.flatMap((result) => Console.log(JSON.stringify(result))),
		Effect.provide(BunServices.layer),
		Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
		Effect.catchCause(() =>
			Console.error("Store transfer failed; preserve transfer journals and inspect the protected configuration.").pipe(
				Effect.andThen(Effect.fail(invalid())),
			),
		),
	);
	BunRuntime.runMain(main, { disableErrorReporting: true });
}
