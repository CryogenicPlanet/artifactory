import { Config, type Duration, Effect, Exit, FileSystem, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { RemoteStore } from "./store.ts";

export class RemoteCopyError extends Schema.TaggedError<RemoteCopyError>()("RemoteCopyError", {
	code: Schema.Literals([
		"copy_target_invalid",
		"copy_ownership_unsupported",
		"backup_engine_mismatch",
		"backup_failed",
		"clone_load_failed",
		"rehearsal_copy_timeout",
	]),
}) {}
export interface RemoteArtifact {
	readonly path: string;
	readonly engine: "pg" | "mysql";
}
interface CopyOptions {
	readonly store: RemoteStore;
	readonly budget: Duration.Input;
	readonly tls: boolean;
}
const invalid = () => new RemoteCopyError({ code: "copy_target_invalid" });
const connection = (store: RemoteStore) =>
	Effect.try({
		try: () => {
			const url = new URL(Redacted.value(store.url));
			const expected = store._tag === "postgres" ? "postgres:" : "mysql:";
			// Native clients interpret some database arguments as options or connection strings.
			if (
				url.protocol !== expected ||
				url.search ||
				url.hash ||
				!url.hostname ||
				decodeURIComponent(url.pathname.slice(1)) !== store.database ||
				store.database.length === 0 ||
				store.database === "." ||
				store.database === ".." ||
				/[\\/\x00-\x1f\x7f]/.test(store.database)
			)
				throw invalid();
			const username = decodeURIComponent(url.username);
			const password = decodeURIComponent(url.password);
			if (!username || (username + password).includes(String.fromCharCode(0))) throw invalid();
			return {
				host: url.hostname.replace(/^\[|\]$/g, ""),
				port: url.port || (store._tag === "postgres" ? "5432" : "3306"),
				username,
				password,
			};
		},
		catch: invalid,
	});
const quoted = (value: string) =>
	`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

/** Native tool stderr can contain credentials and SQL values. Discard it, returning only static failure codes. */
const command = (
	store: RemoteStore,
	load: boolean,
	tls: boolean,
	ownership: "preserve" | "current-role" = "preserve",
) =>
	Effect.gen(function* () {
		const selected = yield* connection(store);
		if (store._tag === "mysql" && ownership === "current-role")
			return yield* new RemoteCopyError({ code: "copy_ownership_unsupported" });
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const searchPath = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
		if (store._tag === "postgres")
			return ChildProcess.make(
				load ? "pg_restore" : "pg_dump",
				load
					? [
							"--exit-on-error",
							...(ownership === "current-role" ? ["--no-owner", "--no-acl"] : []),
							"--dbname",
							`dbname='${store.database.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
						]
					: ["--format=custom"],
				{
					env: {
						PATH: searchPath,
						LC_ALL: "C",
						PGHOST: selected.host,
						PGPORT: selected.port,
						PGUSER: selected.username,
						PGPASSWORD: selected.password,
						PGDATABASE: store.database,
						PGPASSFILE: "/dev/null",
						PGSSLMODE: tls ? "verify-full" : "disable",
						...(tls ? { PGSSLROOTCERT: "system" } : {}),
					},
					extendEnv: false,
					stderr: "ignore",
					forceKillAfter: "1 second",
				},
			);
		const directory = yield* fs.makeTempDirectoryScoped({ prefix: "comms-db-credentials-" });
		yield* fs.chmod(directory, 0o700);
		const defaults = path.join(directory, "client.cnf");
		yield* fs.writeFileString(
			defaults,
			`[client]\nhost=${quoted(selected.host)}\nport=${selected.port}\nuser=${quoted(selected.username)}\npassword=${quoted(selected.password)}\nprotocol=TCP\n`,
			{ flag: "wx", mode: 0o600 },
		);
		return ChildProcess.make(
			load ? "mysql" : "mysqldump",
			[
				`--defaults-file=${defaults}`,
				"--no-login-paths",
				tls ? "--ssl-mode=VERIFY_IDENTITY" : "--ssl-mode=DISABLED",
				...(tls ? ["--ssl-ca=/etc/ssl/certs/ca-certificates.crt"] : []),
				...(load
					? ["--binary-mode", `--database=${store.database}`]
					: [
							"--single-transaction",
							"--no-tablespaces",
							"--set-gtid-purged=OFF",
							"--triggers",
							"--hex-blob",
							"--no-create-db",
							"--",
							store.database,
						]),
			],
			{ env: { PATH: searchPath, LC_ALL: "C" }, extendEnv: false, stderr: "ignore", forceKillAfter: "1 second" },
		);
	});
const bounded = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	budget: Duration.Input,
	failure: "backup_failed" | "clone_load_failed",
) =>
	effect.pipe(
		Effect.timeoutOrElse({
			duration: budget,
			orElse: () => Effect.fail(new RemoteCopyError({ code: "rehearsal_copy_timeout" })),
		}),
		Effect.mapError((error) => (Schema.is(RemoteCopyError)(error) ? error : new RemoteCopyError({ code: failure }))),
	);

/** Creates a new protected artifact. Never truncates an existing file; callers catalog only a successful return. */
export const dumpRemote = (options: CopyOptions & { readonly path: string }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!path.isAbsolute(options.path)) return yield* invalid();
		let created = false;
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const cmd = yield* command(options.store, false, options.tls);
				const output = yield* fs.open(options.path, { flag: "wx", mode: 0o600 });
				created = true;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const process = yield* spawner.spawn(cmd);
				const [code] = yield* Effect.all(
					[process.exitCode, Stream.runForEach(process.stdout, (chunk) => output.writeAll(chunk))],
					{
						concurrency: "unbounded",
					},
				);
				if (code !== 0) return yield* new RemoteCopyError({ code: "backup_failed" });
				yield* output.sync;
				const bytes = Number((yield* output.stat).size);
				const parent = yield* fs.open(path.dirname(options.path));
				yield* parent.sync;
				return {
					path: options.path,
					engine: options.store._tag === "postgres" ? "pg" : "mysql",
					bytes,
				} satisfies RemoteArtifact & { readonly bytes: number };
			}),
		).pipe(
			(effect) => bounded(effect, options.budget, "backup_failed"),
			Effect.onExit((exit) =>
				Exit.isFailure(exit) && created ? fs.remove(options.path, { force: true }).pipe(Effect.orDie) : Effect.void,
			),
		);
	});

/** Loads a trusted native artifact into an already-created destination. Does not create, drop or publish store authority. */
export const loadRemote = (
	options: CopyOptions & { readonly artifact: RemoteArtifact; readonly ownership?: "preserve" | "current-role" },
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const engine = options.store._tag === "postgres" ? "pg" : "mysql";
			if (options.artifact.engine !== engine) return yield* new RemoteCopyError({ code: "backup_engine_mismatch" });
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			if (!path.isAbsolute(options.artifact.path)) return yield* invalid();
			const cmd = yield* command(options.store, true, options.tls, options.ownership);
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const process = yield* spawner.spawn(cmd);
			const [code] = yield* Effect.all(
				[
					process.exitCode,
					Stream.run(fs.stream(options.artifact.path), process.stdin),
					Stream.runDrain(process.stdout),
				],
				{ concurrency: "unbounded" },
			);
			if (code !== 0) return yield* new RemoteCopyError({ code: "clone_load_failed" });
		}),
	).pipe((effect) => bounded(effect, options.budget, "clone_load_failed"));
