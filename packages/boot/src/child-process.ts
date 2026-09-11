import { Deferred, Effect, Exit, FileSystem, Path, Ref, Schema, Scope, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class ChildError extends Schema.TaggedError<ChildError>()("ChildError", {
	code: Schema.String,
	stderr: Schema.optionalKey(Schema.String),
}) {
	get message() {
		return `Child operation failed: ${this.code}`;
	}
}
export interface Launch {
	readonly entry: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly receipt: string;
	readonly attempt: string;
}
const Configuration = Schema.Struct({
	entry: Schema.String,
	cwd: Schema.String,
	env: Schema.Record(Schema.String, Schema.String),
	receipt: Schema.String,
	attempt: Schema.String,
});

/** One keeper-owned process lifetime, with positive exit evidence independent of boot's lifetime. */
export const launchChild = Effect.fn("launchChild")(function* (options: Launch) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const client = yield* HttpClient.HttpClient;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const entry = yield* path.fromFileUrl(new URL(`./child-keeper.${extension}`, import.meta.url));
	const scope = yield* Scope.fork(yield* Effect.scope);
	const stderr = yield* Ref.make("");
	return yield* Effect.gen(function* () {
		const configuration = yield* Schema.encodeEffect(Schema.fromJsonString(Configuration))(options);
		const handle = yield* spawner
			.spawn(
				ChildProcess.make(process.execPath, [entry], {
					env: { COMMS_CHILD_CONFIG: configuration },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					forceKillAfter: "5 seconds",
				}),
			)
			.pipe(Effect.provideService(Scope.Scope, scope));
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
		yield* handle.stderr.pipe(
			Stream.decodeText(),
			Stream.runForEach((chunk) => Ref.update(stderr, (text) => (text + chunk).slice(-8192))),
			Effect.forkIn(scope),
		);
		const port = yield* Effect.raceFirst(
			Deferred.await(ready),
			handle.exitCode.pipe(Effect.andThen(Effect.fail(new ChildError({ code: "child_exited" })))),
		).pipe(Effect.timeout("5 seconds"));
		const processId = yield* Deferred.await(pid);
		const secret = options.env.BOOT_SECRET ?? "";
		const control = (action: "go" | "accepted" | "live" | "frozen" | "draining") =>
			Effect.gen(function* () {
				const response = yield* client.execute(
					HttpClientRequest.post(`http://127.0.0.1:${port}/_kernel/control`).pipe(
						HttpClientRequest.setHeader("x-boot-secret", secret),
						HttpClientRequest.bodyJsonUnsafe({ action }),
					),
				);
				if (response.status !== 200) return yield* new ChildError({ code: "child_control_failed" });
			}).pipe(Effect.timeout("5 seconds"));
		const health = Effect.gen(function* () {
			// Only initialization readiness is polled. Once the DB/router is installed, one full probe owns its deadline.
			while (true) {
				const response = yield* client.execute(
					HttpClientRequest.get(`http://127.0.0.1:${port}/health`, { headers: { "x-boot-secret": secret } }),
				);
				if (
					response.status === 200 &&
					response.headers["x-comms-writer-epoch"] === options.env.WRITER_EPOCH &&
					response.headers["x-comms-kernel-protocol"] === "2"
				)
					return;
				if (response.headers["x-comms-health-ready"] === "1") return yield* new ChildError({ code: "health_failed" });
				yield* Effect.sleep("20 millis");
			}
		});
		const stop = Effect.gen(function* () {
			yield* Scope.close(scope, Exit.void);
			yield* handle.exitCode.pipe(Effect.exit);
			if (yield* handle.isRunning) return yield* new ChildError({ code: "keeper_closure_unproven" });
			const receipt = yield* fs
				.readFileString(options.receipt)
				.pipe(Effect.mapError(() => new ChildError({ code: "child_closure_unproven" })));
			if (receipt !== options.attempt) return yield* new ChildError({ code: "child_closure_unproven" });
		});
		return { port, pid: processId, stderr, control, health, stop, exited: handle.exitCode.pipe(Effect.exit) };
	}).pipe(
		Effect.onError(() => Scope.close(scope, Exit.void)),
		Effect.catch((error) =>
			Effect.gen(function* () {
				return yield* new ChildError({
					code: Schema.is(ChildError)(error) ? error.code : String(error),
					stderr: yield* Ref.get(stderr),
				});
			}),
		),
	);
});
export type RunningChild = Effect.Success<ReturnType<typeof launchChild>>;
