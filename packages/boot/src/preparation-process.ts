import { Context, Effect, Layer, Path, type PlatformError, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ChildError } from "./child-process.ts";

const Configuration = Schema.Struct({
	operation: Schema.Literals(["install", "build"]),
	workspace: Schema.String,
	output: Schema.String,
});

/** Fixed subprocess commands; scope interruption also closes the keeper's pipe.
 * No app lifecycle scripts, inherited credentials, or editable entry in boot. */
export class PreparationProcess extends Context.Service<
	PreparationProcess,
	{
		readonly install: (workspace: string) => Effect.Effect<void, ChildError | PlatformError.PlatformError>;
		readonly build: (
			workspace: string,
			output: string,
		) => Effect.Effect<void, ChildError | PlatformError.PlatformError>;
	}
>()("comms/boot/PreparationProcess") {}

export const layer = Layer.effect(
	PreparationProcess,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const path = yield* Path.Path;
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const entry = yield* path.fromFileUrl(new URL(`./preparation-keeper.${extension}`, import.meta.url));
		const run = (operation: "install" | "build", workspace: string, output: string) =>
			Effect.gen(function* () {
				const stderr = yield* Ref.make("");
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const configuration = yield* Schema.encodeEffect(Schema.fromJsonString(Configuration))({
							operation,
							workspace,
							output,
						}).pipe(Effect.orDie);
						const child = yield* spawner.spawn(
							ChildProcess.make(process.execPath, [entry], {
								env: { COMMS_PREPARATION_CONFIG: configuration },
								stdin: "pipe",
								stdout: "ignore",
								stderr: "pipe",
								forceKillAfter: "5 seconds",
							}),
						);
						yield* child.stderr.pipe(
							Stream.decodeText(),
							Stream.runForEach((chunk) => Ref.update(stderr, (value) => (value + chunk).slice(-8192))),
							Effect.forkScoped,
						);
						const code = yield* child.exitCode.pipe(
							Effect.timeoutOrElse({
								duration: operation === "install" ? "60 seconds" : "120 seconds",
								orElse: () => Effect.fail(new ChildError({ code: `preparation_${operation}_timeout` })),
							}),
						);
						if (code !== 0) return yield* new ChildError({ code: `preparation_${operation}_failed` });
					}),
				).pipe(
					Effect.catchCause((cause) => {
						const reason = cause.reasons[0];
						if (cause.reasons.length !== 1 || reason?._tag !== "Fail" || !Schema.is(ChildError)(reason.error))
							return Effect.failCause(cause);
						const error = reason.error;
						return Effect.gen(function* () {
							return yield* new ChildError({
								code: error.code,
								stderr: (yield* Ref.get(stderr)).replace(/[a-f0-9]{64}/g, "[redacted]"),
							});
						});
					}),
				);
			});
		return PreparationProcess.of({
			install: (workspace) => run("install", workspace, ""),
			build: (workspace, output) => run("build", workspace, output),
		});
	}),
);
