import { Effect, Runtime, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class ServerExited extends Schema.TaggedError<ServerExited>()("ServerExited", {
	code: Schema.Int,
}) {
	readonly [Runtime.errorExitCode] = this.code;
}

/** Starts the server child and owns its lifetime.
 * Accepts an entry path; never imports server implementation code. */
export const boot = Effect.fn("boot")(function* (entry: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const child = yield* spawner.spawn(
		ChildProcess.make(process.execPath, [entry], {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			forceKillAfter: "3 seconds",
		}),
	);
	yield* Effect.log(`boot: started server process ${child.pid}`);
	const code = yield* child.exitCode;
	if (code !== 0) return yield* new ServerExited({ code });
});
