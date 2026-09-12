import {
	Config,
	Crypto,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Option,
	Path,
	Schema,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { ChildError } from "./child-process.ts";
import { readKernelBootId, validateKernelBootId } from "./kernel-boot.ts";
import { SqliteCopyConfiguration, SqliteCopyIntent, SqliteCopyReceipt } from "./sqlite-copy-configuration.ts";

const unproven = () => new ChildError({ code: "sqlite_copy_closure_unproven" });
/** One boot-owned SQLite copy intent; recover before filesystem migration, cleanup or traffic resumption. */
export const sqliteCopyProcess = (source: string, directory: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const crypto = yield* Crypto.Crypto;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const bootId = yield* readKernelBootId(process.platform);
		const budgetMs = Duration.toMillis(
			yield* Config.Duration("REHEARSAL_COPY_BUDGET").pipe(Config.withDefault(Duration.seconds(30))),
		);
		if (!Number.isFinite(budgetMs) || budgetMs <= 0) return yield* new ChildError({ code: "sqlite_copy_invalid" });
		const gate = yield* Semaphore.make(1);
		const read = sql`SELECT value FROM settings WHERE key='sqlite_copy'`.pipe(
			Effect.flatMap((rows) => {
				const value = rows[0]?.value;
				return value === undefined
					? Effect.succeed(null)
					: Schema.decodeUnknownEffect(Schema.fromJsonString(SqliteCopyIntent))(value).pipe(Effect.mapError(unproven));
			}),
		);
		const validate = (intent: typeof SqliteCopyIntent.Type) =>
			Effect.gen(function* () {
				const root = yield* fs.realPath(directory);
				const relative = path.relative(root, intent.destination);
				if (
					!/^[a-f0-9]{64}$/.test(intent.attempt) ||
					intent.receipt !== path.join(root, "sqlite-copies", `${intent.attempt}.closed`) ||
					!path.isAbsolute(intent.source) ||
					["", "-journal", "-wal", "-shm"].some(
						(suffix) => intent.source + suffix === intent.destination || intent.destination + suffix === intent.source,
					) ||
					relative === "" ||
					relative === ".." ||
					relative.startsWith(`..${path.sep}`) ||
					path.isAbsolute(relative)
				)
					return yield* unproven();
			});
		const receipt = (intent: typeof SqliteCopyIntent.Type) =>
			fs.readFileString(intent.receipt).pipe(
				Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SqliteCopyReceipt))),
				Effect.flatMap((value) =>
					value.attempt === intent.attempt && value.source === intent.source && value.destination === intent.destination
						? Effect.succeed(value)
						: Effect.fail(unproven()),
				),
				Effect.catchIf(
					(error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
					() => Effect.succeed(null),
				),
				Effect.mapError(unproven),
			);
		const forget = (intent: typeof SqliteCopyIntent.Type) =>
			sql`DELETE FROM settings WHERE key='sqlite_copy' AND value=${Schema.encodeSync(Schema.fromJsonString(SqliteCopyIntent))(intent)}`.pipe(
				Effect.asVoid,
				Effect.andThen(fs.remove(intent.receipt, { force: true })),
			);
		const remove = (intent: typeof SqliteCopyIntent.Type) =>
			Effect.gen(function* () {
				// A completed catalog write may outlive a lost response. Never delete a registered artifact.
				if ((yield* sql`SELECT id FROM backups WHERE path=${intent.destination} LIMIT 1`).length > 0) return;
				if ((yield* fs.realPath(path.dirname(intent.destination))) !== path.dirname(intent.destination))
					return yield* unproven();
				for (const suffix of ["", "-journal", "-wal", "-shm"])
					yield* fs.remove(`${intent.destination}${suffix}`, { force: true });
				yield* Effect.scoped(fs.open(path.dirname(intent.destination)).pipe(Effect.flatMap((file) => file.sync)));
			});
		const recover = Effect.gen(function* () {
			const intent = yield* read;
			if (!intent) return;
			yield* validate(intent);
			const priorBootId = validateKernelBootId(intent.boot_id);
			let closed = bootId !== null && priorBootId !== null && bootId !== priorBootId;
			for (let attempt = 0; attempt < 60 && !closed; attempt++) {
				closed = (yield* receipt(intent)) !== null;
				if (!closed) yield* Effect.sleep("100 millis");
			}
			if (!closed) return yield* unproven();
			yield* remove(intent);
			yield* forget(intent);
		});
		const copy = (destination: string) =>
			gate.withPermit(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						yield* recover;
						if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
							return yield* new ChildError({ code: "sqlite_copy_invalid" });
						const root = yield* fs.realPath(directory);
						const canonicalSource = yield* fs.realPath(source);
						const canonicalDestination = path.join(
							yield* fs.realPath(path.dirname(destination)),
							path.basename(destination),
						);
						if (canonicalSource === canonicalDestination || (yield* fs.exists(canonicalDestination)))
							return yield* new ChildError({ code: "sqlite_copy_invalid" });
						const link = yield* fs.readLink(canonicalDestination).pipe(Effect.result);
						if (link._tag === "Success" || link.failure.reason._tag !== "NotFound")
							return yield* new ChildError({ code: "sqlite_copy_invalid" });
						const attempt = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
						const intent = {
							attempt,
							source: canonicalSource,
							destination: canonicalDestination,
							receipt: path.join(root, "sqlite-copies", `${attempt}.closed`),
							budgetMs,
							boot_id: bootId,
						};
						yield* validate(intent);
						yield* fs.makeDirectory(path.dirname(intent.receipt), { recursive: true, mode: 0o700 });
						yield* sql`INSERT INTO settings(key,value) VALUES('sqlite_copy',${Schema.encodeSync(Schema.fromJsonString(SqliteCopyIntent))(intent)})`;
						const scope = yield* Scope.make();
						const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
						const entry = yield* path.fromFileUrl(new URL(`./sqlite-copy-keeper.${extension}`, import.meta.url));
						return yield* Effect.gen(function* () {
							const handle = yield* spawner
								.spawn(
									ChildProcess.make(process.execPath, [entry], {
										env: {
											COMMS_SQLITE_COPY: Schema.encodeSync(Schema.fromJsonString(SqliteCopyConfiguration))(intent),
										},
										extendEnv: false,
										stdin: "pipe",
										stdout: "ignore",
										stderr: "ignore",
										detached: true,
									}),
								)
								.pipe(Effect.provideService(Scope.Scope, scope));
							const close = Stream.run(Stream.empty, handle.stdin).pipe(
								Effect.ignore,
								Effect.andThen(handle.exitCode),
								Effect.timeout("5 seconds"),
								Effect.mapError(unproven),
							);
							const result = yield* restore(handle.exitCode).pipe(
								Effect.onInterrupt(() => close.pipe(Effect.orDie)),
								Effect.exit,
							);
							const proof = yield* receipt(intent);
							if (!proof) return yield* unproven();
							if (proof.outcome !== "completed" || result._tag === "Failure") yield* remove(intent);
							yield* forget(intent);
							if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
							if (proof.outcome !== "completed")
								return yield* new ChildError({
									code: proof.outcome === "timeout" ? "rehearsal_copy_timeout" : "sqlite_copy_failed",
								});
							return (yield* fs.stat(canonicalDestination)).size;
						}).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
					}),
				),
			);
		return { copy, recover };
	});
