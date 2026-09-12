import { Cause, Config, Effect, Exit, FileSystem, Path, Redacted, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { RemoteArtifact } from "@comms/storage/remote-copy";
import { render, type RemoteStore } from "@comms/storage/store";
import type { RemoteChildConfiguration } from "./keeper-configuration.ts";
import { NativeCopyConfiguration, NativeCopyRejected, NativeCopyReceipt } from "./native-copy-configuration.ts";

export type NativeCopyOperation = {
	readonly id: string;
	readonly store: RemoteStore;
	readonly budgetMs: number;
	readonly remote: typeof RemoteChildConfiguration.Type;
} & (
	| { readonly operation: "dump"; readonly path: string }
	| { readonly operation: "load"; readonly artifact: RemoteArtifact; readonly ownership: "preserve" | "current-role" }
);

/** Reservation metadata must be durable before this function may spawn a keeper. */
export const nativeCopyRunner = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
	const searchPath = yield* Config.String("PATH").pipe(Config.withDefault("/usr/local/bin:/usr/bin:/bin"));
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const entry = yield* path.fromFileUrl(new URL(`./native-copy-keeper.${extension}`, import.meta.url));
	return (operation: NativeCopyOperation) =>
		Effect.gen(function* () {
			const remote = operation.remote;
			const configuration = Schema.encodeSync(Schema.fromJsonString(NativeCopyConfiguration))({
				id: operation.id,
				store: Redacted.value(render(operation.store)),
				remote,
				operation: operation.operation,
				path: operation.operation === "dump" ? operation.path : operation.artifact.path,
				engine:
					operation.operation === "dump"
						? operation.store._tag === "postgres"
							? "pg"
							: "mysql"
						: operation.artifact.engine,
				budgetMs: operation.budgetMs,
				ownership: operation.operation === "load" ? operation.ownership : "preserve",
			});
			const scope = yield* Scope.make();
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const handle = yield* spawner
						.spawn(
							ChildProcess.make(
								isolated ? "/usr/bin/sudo" : process.execPath,
								isolated ? ["-n", "/opt/comms/deployment/native-copy-keeper"] : [entry],
								{
									env: { COMMS_NATIVE_COPY_CONFIG: configuration, PATH: searchPath },
									extendEnv: false,
									stdin: "pipe",
									stdout: "ignore",
									stderr: "ignore",
									detached: true,
								},
							),
						)
						.pipe(Effect.provideService(Scope.Scope, scope));
					const finish = Stream.run(Stream.empty, handle.stdin).pipe(
						Effect.ignore,
						Effect.andThen(handle.exitCode),
						Effect.ensuring(Scope.close(scope, Exit.void)),
					);
					const code = yield* restore(handle.exitCode).pipe(Effect.onInterrupt(() => finish.pipe(Effect.orDie)));
					yield* finish;
					if (code !== 0) return yield* new NativeCopyRejected({ code: "native_copy_failed" });
					const result = yield* fs
						.readFileString(path.join(remote.dataDirectory, "remote-owners", `${operation.id}.json`))
						.pipe(
							Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NativeCopyReceipt))),
							Effect.mapError(() => new NativeCopyRejected({ code: "native_copy_closure_unproven" })),
						);
					if (result.attempt !== operation.id || result.root !== remote.root)
						return yield* new NativeCopyRejected({ code: "native_copy_closure_unproven" });
					const bytes = operation.operation === "dump" ? Number((yield* fs.stat(operation.path)).size) : 0;
					if (!Number.isSafeInteger(bytes) || bytes < 0)
						return yield* new NativeCopyRejected({ code: "native_copy_failed" });

					return {
						path: operation.operation === "dump" ? operation.path : operation.artifact.path,
						engine: operation.store._tag === "postgres" ? ("pg" as const) : ("mysql" as const),
						bytes,
					};
				}),
			).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
		}).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.fail(new NativeCopyRejected({ code: "native_copy_failed" })),
			),
		);
});
