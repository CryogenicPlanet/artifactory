import { render } from "@comms/storage/store";
import { Config, Effect, Path, Redacted, Schema, Stream, Semaphore } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ErrorEnvelope } from "@comms/protocol/errors";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { sqlInput, type SqlInput } from "./sql-input.ts";
import { ReadRequest, ReadResponse } from "./sql-read-wire.ts";

/** A disposable readonly process owns each query and its registered remote leases. */
const inspectSql = (input: typeof SqlInput.Type, allowRead: boolean) =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* sqlInput(input);
			const boot = yield* BootChannel;
			const environment =
				boot.store._tag === "file"
					? {}
					: {
							REMOTE_ATTEMPT: yield* Config.String("REMOTE_ATTEMPT"),
							REMOTE_GUARDIAN_URL: yield* Config.String("REMOTE_GUARDIAN_URL"),
							REMOTE_GUARDIAN_SECRET: Redacted.value(yield* Config.Redacted("REMOTE_GUARDIAN_SECRET")),
							DATABASE_TLS: yield* Config.String("DATABASE_TLS"),
						};
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const relative = import.meta.url.endsWith(".ts") ? "./sql-read-worker.ts" : "./kernel/sql-read-worker.js";
			const entry = yield* path.fromFileUrl(new URL(relative, import.meta.url));
			const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ReadRequest))({
				store: Redacted.value(yield* render(boot.store)),
				allowRead,
				input,
			});
			if (new TextEncoder().encode(encoded).byteLength > 70000)
				return yield* new KernelError({ code: "input_invalid" });
			const child = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [entry], {
					env: environment,
					detached: false,
					stdin: Stream.make(new TextEncoder().encode(encoded)),
					stdout: "pipe",
					stderr: "ignore",
					killSignal: "SIGKILL",
				}),
			);
			// Reap before responding or releasing the request scope. Same process group lets the app keeper close an orphan.
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					if (yield* child.isRunning) yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.exit);
					yield* child.exitCode.pipe(Effect.exit);
				}).pipe(Effect.orDie),
			);
			const output = yield* child.stdout.pipe(
				Stream.decodeText(),
				Stream.runFoldEffect(
					() => "",
					(text, chunk) =>
						new TextEncoder().encode(text + chunk).byteLength > 131072
							? Effect.die("SQL worker response exceeded limit")
							: Effect.succeed(text + chunk),
				),
			);
			if ((yield* child.exitCode) !== 0) return yield* Effect.die("SQL read worker failed");
			const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReadResponse))(output);
			if (Schema.is(ErrorEnvelope)(response)) return yield* Effect.fail(response);
			return response;
		}),
	);

/** One handler group owns two readers; waiting for a slot shares the total read budget. */
export const makeSqlReader = Effect.gen(function* () {
	const slots = yield* Semaphore.make(2);
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	return (input: typeof SqlInput.Type, allowRead: boolean) =>
		slots
			.withPermit(
				inspectSql(input, allowRead).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
			)
			.pipe(
				Effect.timeoutOrElse({
					duration: "3 seconds",
					orElse: () => Effect.fail(new KernelError({ code: "sql_query_timeout" })),
				}),
			);
});
