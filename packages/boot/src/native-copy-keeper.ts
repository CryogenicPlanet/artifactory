import { BunRuntime, BunServices } from "@effect/platform-bun";
import { RemoteInspector, remoteOwnerInspectorLayer } from "@comms/storage/remote-inspector";
import { dumpRemote, loadRemote } from "@comms/storage/remote-copy";
import { asBoot, connectionOf, parseDescriptor } from "@comms/storage/store";
import { Config, Context, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema, Scope, Stdio, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { NativeCopyConfiguration, NativeCopyRejected } from "./native-copy-configuration.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { admitRemoteOwner } from "./remote-root-protocol.ts";
import { remoteOwner } from "./remote-owner.ts";

const rejected = () => new NativeCopyRejected({ code: "native_copy_invalid" });
const keeper = Effect.gen(function* () {
	const encoded = yield* Config.Redacted("COMMS_NATIVE_COPY_CONFIG");
	const config = yield* Schema.decodeEffect(Schema.fromJsonString(NativeCopyConfiguration))(
		Redacted.value(encoded),
	).pipe(Effect.mapError(rejected));
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
	if (
		!/^[a-f0-9]{64}$/.test(config.id) ||
		!path.isAbsolute(config.path) ||
		!Number.isFinite(config.budgetMs) ||
		config.budgetMs <= 0 ||
		(isolated && config.remote.dataDirectory !== "/data")
	)
		return yield* rejected();
	const store = yield* parseDescriptor(config.store);
	const boot = yield* parseDescriptor(config.remote.bootStore);
	if (store._tag === "file" || boot._tag === "file") return yield* rejected();
	yield* asBoot(store, boot);
	const connection = yield* connectionOf(store, config.remote.tls);
	const bootConnection = yield* connectionOf(boot, config.remote.tls);
	yield* admitRemoteOwner(config.remote, config.id);
	const owner = yield* remoteOwner(
		config.remote.dataDirectory,
		{
			attempt: config.id,
			root: config.remote.root,
			scope: "account",
			engine: connection.engine,
			host: connection.host,
			port: connection.port,
			tls: connection.tls,
			database: connection.database,
			username: connection.username,
		},
		isolated ? { uid: 1000, gid: 1000 } : undefined,
	);
	const services = yield* Layer.build(
		remoteOwnerInspectorLayer({
			connection,
			attempt: config.id,
			...(connection.engine === "mysql" ? { mysqlBootConnection: bootConnection } : {}),
		}),
	);
	const inspector = Context.get(services, RemoteInspector);
	yield* owner.bindInspector(inspector.server);
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const processScope = yield* Scope.make();
	let child: ChildProcessSpawner.ChildProcessHandle | undefined;
	let spawnAttempted = false;
	const groupRunning = Effect.try(() => {
		if (!child) {
			if (spawnAttempted) throw new Error("Native process closure is unknown");
			return false;
		}
		try {
			process.kill(-Number(child.pid), 0);
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
			throw new Error("Native process closure is unknown");
		}
	}).pipe(Effect.orDie);
	const localClosure = Effect.gen(function* () {
		if (yield* groupRunning) {
			// Leader exit does not close its group. Signal the group directly, including surviving descendants.
			yield* Effect.try(() => {
				if (child) {
					try {
						process.kill(-Number(child.pid), "SIGKILL");
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
							throw new Error("Native process closure is unknown");
					}
				}
			}).pipe(Effect.orDie);
		}
		yield* Scope.close(processScope, Exit.void);
		if (child) {
			yield* child.exitCode.pipe(Effect.exit);
			if (yield* child.isRunning.pipe(Effect.orDie)) return yield* Effect.die("Native process closure is unknown");
		}
		for (let attempt = 0; attempt < 50; attempt++) {
			if (!(yield* groupRunning)) return;
			yield* Effect.sleep("20 millis");
		}
		return yield* Effect.die("Native process closure is unknown");
	});
	const proveClosure = Effect.gen(function* () {
		yield* localClosure;
		// A disconnected native client's query can finish on the server later. Keep
		// observing through this same reserved inspector; never reopen a connection.
		for (let attempt = 0; ; attempt++) {
			const observed = yield* inspector.assertAccountClosed(Effect.void).pipe(Effect.result);
			if (observed._tag === "Success") return;
			if (attempt === 150) return yield* observed.failure;
			yield* Effect.sleep("200 millis");
		}
	});
	// This finalizer runs before the inspector scope closes, on success, timeout, or parent EOF.
	yield* Effect.addFinalizer(() =>
		owner.close(proveClosure).pipe(Effect.ensuring(Scope.close(processScope, Exit.void)), Effect.orDie),
	);
	const tracked = ChildProcessSpawner.make((command) =>
		Effect.uninterruptible(
			Effect.gen(function* () {
				if (spawnAttempted || !ChildProcess.isStandardCommand(command))
					return yield* Effect.die("Invalid native command");
				spawnAttempted = true;
				child = yield* spawner
					.spawn(
						ChildProcess.make(command.command, command.args, {
							...command.options,
							detached: true,
							extendEnv: false,
						}),
					)
					.pipe(Effect.provideService(Scope.Scope, processScope));
				return child;
			}),
		),
	);
	const operation =
		config.operation === "dump"
			? dumpRemote({ store, path: config.path, budget: config.budgetMs, tls: config.remote.tls }).pipe(
					Effect.map((artifact) => artifact.bytes),
				)
			: loadRemote({
					store,
					artifact: { path: config.path, engine: config.engine },
					budget: config.budgetMs,
					tls: config.remote.tls,
					ownership: config.ownership,
				}).pipe(Effect.as(0));
	const stdio = yield* Stdio.Stdio;
	yield* Effect.raceFirst(
		operation.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, tracked)),
		stdio.stdin.pipe(
			Stream.runDrain,
			Effect.andThen(Effect.fail(new NativeCopyRejected({ code: "native_copy_failed" }))),
		),
	);
	yield* owner.close(proveClosure);
	if (isolated && config.operation === "dump") {
		yield* fs.chown(config.path, 1000, 1000);
		yield* Effect.scoped(fs.open(config.path).pipe(Effect.flatMap((file) => file.sync)));
	}
}).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)));

// Decoder, filesystem and native driver failures may contain private configuration. No cause crosses this boundary.
keeper.pipe(
	Effect.catchCause(() =>
		Effect.sync(() => {
			process.exitCode = 1;
		}),
	),
	Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
	BunRuntime.runMain,
);
