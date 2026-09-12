import { closeSync } from "node:fs";
import { databaseConfiguration } from "@comms/boot";
import { ConfigProvider, Effect, Schema, Stdio, Stream } from "effect";
import { TransferRejected } from "@comms/storage/store-transfer-schema";

const Descriptors = Schema.Struct({ boot: Schema.String, app: Schema.String });
const Input = Schema.Struct({
	version: Schema.Literal(1),
	transfer_id: Schema.String,
	mode: Schema.Literals(["check", "transfer"]),
	source: Descriptors,
	target: Descriptors,
	tls: Schema.Boolean,
});
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
	const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(encoded).pipe(Effect.mapError(invalid));
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(input.transfer_id))
		return yield* invalid();
	const pair = (descriptors: typeof Descriptors.Type) =>
		databaseConfiguration("/unselected/boot.db", "/unselected/app.db").pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown({
					DATABASE_URL: descriptors.app,
					BOOT_DATABASE_URL: descriptors.boot,
					DATABASE_TLS: input.tls,
				}),
			),
			Effect.mapError(invalid),
		);
	const source = yield* pair(input.source);
	const target = yield* pair(input.target);
	const engine = (configuration: typeof source) =>
		configuration._tag === "file" ? "sqlite" : configuration.bootConnection.engine;
	if (engine(source) === engine(target)) return yield* invalid();
	return { transferId: input.transfer_id, mode: input.mode, source, target };
});
