import { ChildConfiguration } from "./keeper-configuration.ts";
import { logRedactor } from "./log-redaction.ts";
import { Deferred, Effect, Exit, FileSystem, Path, Ref, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ChildError } from "./child-error.ts";

/** Shared keeper lifetime for serving children and finite offline app tasks. */
export const startChildKeeper = (options: typeof ChildConfiguration.Type, isolated: boolean) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const entry = yield* path.fromFileUrl(new URL(`./child-keeper.${extension}`, import.meta.url));
		const scope = yield* Scope.fork(yield* Effect.scope);
		const stderr = yield* Ref.make("");
		const redact = logRedactor([options.env.APP_STORE ?? "", options.env.BOOT_SECRET ?? ""]);
		return yield* Effect.gen(function* () {
			const configuration = yield* Schema.encodeEffect(Schema.fromJsonString(ChildConfiguration))(options);
			const handle = yield* spawner
				.spawn(
					ChildProcess.make(
						isolated ? "/usr/bin/sudo" : process.execPath,
						isolated ? ["-n", "/opt/comms/deployment/child-keeper"] : [entry],
						{
							env: { COMMS_CHILD_CONFIG: configuration },
							stdin: "pipe",
							stdout: "pipe",
							stderr: "pipe",
							// The pinned remote inspector must survive termination of boot's process group.
							detached: options.remote !== undefined,
							forceKillAfter: "5 seconds",
						},
					),
				)
				.pipe(Effect.provideService(Scope.Scope, scope));
			if (isolated)
				yield* Effect.addFinalizer(() =>
					handle.isRunning.pipe(
						Effect.flatMap((running) =>
							running
								? Stream.run(Stream.empty, handle.stdin).pipe(Effect.interruptible, Effect.timeout("1 second"))
								: Effect.void,
						),
						Effect.ignore,
					),
				).pipe(Effect.provideService(Scope.Scope, scope));
			const ready = yield* Deferred.make<number>();
			const pid = yield* Deferred.make<number>();
			let pending = "";
			yield* handle.stdout.pipe(
				Stream.decodeText(),
				Stream.runForEach((chunk) =>
					Effect.gen(function* () {
						const text = pending + chunk;
						pending = text.slice(-128);
						const port = /(?:^|\n)COMMS_CHILD_PORT=(\d{1,5})\n/.exec(text)?.[1];
						const processId = /(?:^|\n)COMMS_CHILD_PID=(\d+)\n/.exec(text)?.[1];
						if (port && Number(port) > 0 && Number(port) <= 65535) yield* Deferred.succeed(ready, Number(port));
						if (processId) yield* Deferred.succeed(pid, Number(processId));
					}),
				),
				Effect.forkIn(scope),
			);
			let errorLine = "";
			let oversized = false;
			const retain = (text: string) => Ref.update(stderr, (prior) => (prior + redact(text)).slice(-8192));
			yield* handle.stderr.pipe(
				Stream.decodeText(),
				Stream.runForEach((chunk) =>
					Effect.gen(function* () {
						for (const [index, part] of chunk.split("\n").entries()) {
							if (index > 0) {
								yield* retain(oversized ? "[diagnostic line too long]\n" : `${errorLine}\n`);
								errorLine = "";
								oversized = false;
							}
							if (oversized) continue;
							if (errorLine.length + part.length > 65536) {
								errorLine = "";
								oversized = true;
							} else errorLine += part;
						}
					}),
				),
				Effect.andThen(Effect.suspend(() => retain(oversized ? "[diagnostic line too long]" : errorLine))),
				Effect.forkIn(scope),
			);
			// Ownership preparation copies/seals files before editable code exists. Its
			// bounded I/O phase must not consume the child's five-second readiness budget.
			if (isolated)
				yield* Effect.raceFirst(
					Deferred.await(pid),
					handle.exitCode.pipe(Effect.andThen(Effect.fail(new ChildError({ code: "child_exited" })))),
				).pipe(Effect.timeout("60 seconds"));
			// A watchdog and a cutover may close the same lifetime concurrently. Cache the
			// complete closure result; neither a caller interruption nor a retry skips proof.
			const stop = yield* Effect.cached(
				Effect.gen(function* () {
					yield* Scope.close(scope, Exit.void);
					yield* handle.exitCode.pipe(
						Effect.timeout("5 seconds"),
						Effect.mapError(() => new ChildError({ code: "keeper_closure_unproven" })),
					);
					if (yield* handle.isRunning) return yield* new ChildError({ code: "keeper_closure_unproven" });
					const receipt = yield* fs
						.readFileString(options.receipt)
						.pipe(Effect.mapError(() => new ChildError({ code: "child_closure_unproven" })));
					if (receipt !== options.attempt) return yield* new ChildError({ code: "child_closure_unproven" });
				}).pipe(Effect.uninterruptible),
			);
			return { ready, pid, stderr, handle, stop, closeScope: Scope.close(scope, Exit.void) };
		}).pipe(
			Effect.onError(() => Scope.close(scope, Exit.void)),
			Effect.catchCause((cause) => {
				const reason = cause.reasons[0];
				if (cause.reasons.length !== 1 || reason?._tag !== "Fail" || !Schema.is(ChildError)(reason.error))
					return Effect.failCause(cause);
				const error = reason.error;
				return Effect.gen(function* () {
					return yield* new ChildError({
						code: error.code,
						stderr: yield* Ref.get(stderr),
					});
				});
			}),
		);
	});
