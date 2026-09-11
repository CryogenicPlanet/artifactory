import { buildIdentity, prepareWorkspace } from "./linux-ownership.ts";
import { PreparationConfiguration } from "./keeper-configuration.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Config, Console, Effect, Path, Redacted, Schema, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ChildError } from "./child-process.ts";

// This immutable entry only runs the two preparation commands. Pipe EOF cancels
// the scoped process group, including ordinary descendants of editable Vite config.
const keeper = Effect.gen(function* () {
	const encoded = yield* Config.Redacted("COMMS_PREPARATION_CONFIG");
	const config = yield* Schema.decodeEffect(Schema.fromJsonString(PreparationConfiguration))(Redacted.value(encoded));
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const stdio = yield* Stdio.Stdio;
	const args =
		config.operation === "install"
			? ["install", "--frozen-lockfile", "--ignore-scripts"]
			: [
					path.join(config.workspace, "node_modules/vite/bin/vite.js"),
					"build",
					"--outDir",
					config.output,
					"--emptyOutDir",
				];
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
	let spawnAttempted = false;
	let groupClosed = false;
	if (isolated) {
		if (config.output !== "" && config.output !== `${config.workspace}/board`)
			return yield* Effect.die("Invalid build output");
		yield* Effect.addFinalizer(() =>
			!spawnAttempted || groupClosed ? prepareWorkspace(config.workspace, 1000).pipe(Effect.orDie) : Effect.void,
		);
		yield* prepareWorkspace(config.workspace, 1002);
	}
	spawnAttempted = true;
	const child = yield* spawner.spawn(
		ChildProcess.make(
			isolated ? "/usr/bin/setpriv" : process.execPath,
			isolated ? [...buildIdentity, process.execPath, ...args] : args,
			{
				cwd: config.operation === "install" ? config.workspace : path.join(config.workspace, "ui"),
				env: {
					PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
					HOME: config.workspace,
					BUN_INSTALL_CACHE_DIR: path.join(config.workspace, ".bun-cache"),
				},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				detached: true,
				forceKillAfter: "2 seconds",
			},
		),
	);
	// Scoped spawner release skips groups whose leader already exited successfully.
	// Explicit kill is required even on success, before any output can be promoted.
	// Effect exposes leader status but not group status. This narrow POSIX probe
	// treats only ESRCH as absence; permission and other failures stay fatal.
	const groupRunning = Effect.try({
		try: () => {
			try {
				process.kill(-Number(child.pid), 0);
				return true;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
				throw error;
			}
		},
		catch: (error) => new ChildError({ code: "preparation_group_probe_failed", stderr: String(error) }),
	});
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			if (yield* groupRunning)
				yield* child
					.kill({ forceKillAfter: "2 seconds" })
					.pipe(
						Effect.catch((error) =>
							groupRunning.pipe(Effect.flatMap((running) => (running ? Effect.fail(error) : Effect.void))),
						),
					);
			for (let attempt = 0; attempt < 25; attempt++) {
				const probe = yield* groupRunning.pipe(Effect.result);
				if (probe._tag === "Success" && !probe.success) {
					groupClosed = true;
					return;
				}
				yield* Effect.sleep("20 millis");
			}
			if (yield* groupRunning) return yield* new ChildError({ code: "preparation_group_closure_unproven" });
			groupClosed = true;
		}).pipe(Effect.orDie),
	);
	yield* child.stderr.pipe(Stream.run(stdio.stderr()), Effect.forkScoped);
	const code = yield* Effect.raceFirst(child.exitCode, stdio.stdin.pipe(Stream.runDrain, Effect.as(1)));
	if (code !== 0)
		return yield* new ChildError({ code: `preparation_${config.operation}_failed`, stderr: `Exit status ${code}` });
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

keeper.pipe(
	Effect.tapCause((cause) => Console.error(Cause.pretty(cause))),
	Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
	BunRuntime.runMain,
);
