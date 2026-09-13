import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Cause, Console, Deferred, Effect, Fiber, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { ArtifactRetentionRejected } from "../../src/artifact-retention.ts";
import { DbOps, layer as backupLayer } from "../../src/db-ops.ts";
import { AppRecovery, layer as recoveryLayer } from "../../src/app-recovery.ts";
import { layer as ownersLayer } from "../../src/child-attempts.ts";
import { AuthError } from "../../src/auth.ts";
import { ChildError } from "../../src/child-process.ts";
import { type EventRecord, Events, layer as eventsLayer } from "../../src/events.ts";
import { layer as generationsLayer } from "../../src/generations.ts";
import { layer as kernelBootLayer } from "../../src/kernel-boot.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { BackupRecord } from "../../src/backup-metadata.ts";
import { databaseBackup } from "../../src/database-backup.ts";
import type { ActiveChild, ChildStatus, Supervisor } from "../../src/supervisor.ts";
import { traffic } from "../../src/traffic.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	const mode = process.argv[3];
	if (!root) return yield* Effect.die("Missing fixture root");
	const filename = `${root}/app.db`;
	const boot = SqliteClient.layer({ filename: `${root}/boot.db` });
	const program = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* initializeBootSchema;
		const events = yield* Events;
		const recovery = yield* AppRecovery;
		yield* recovery.prepare("original");
		const db = new Database(filename);
		yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
		db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT)");
		const calls: string[] = [];
		const frozen = yield* Deferred.make<void>();
		const routing = yield* traffic;
		const generation = {
			n: 1,
			snapshot_dir: "/fixture",
			entry_file: "server.ts",
			status: "live",
			good: 1,
			stderr: "",
			error: null,
			started_at: 1,
			healthy_at: 1,
			retired_at: null,
			backup_id: null,
		} satisfies ActiveChild["generation"];
		const attempt = {
			epoch: "original",
			secret: "fixture",
			host: "localhost",
			generation: 1,
			state: "live",
		} satisfies ActiveChild["attempt"];
		const active: ActiveChild = {
			store: { _tag: "file", filename },
			id: "owner",
			receipt: "fixture",
			generation,
			attempt,
			process: {
				pid: 1,
				port: 1,
				stderr: yield* Ref.make(""),
				exited: Effect.never,
				health: Effect.never,
				ping: Effect.void,
				drain: Effect.void,
				stop: Effect.never,
				control: (action) =>
					Effect.gen(function* () {
						calls.push(action);
						if (action === "frozen") {
							yield* Deferred.succeed(frozen, undefined);
							if (mode === "freeze-failure" || mode === "closure-failure" || mode === "restart-failure")
								return yield* new ChildError({ code: "child_control_failed" });
						}
					}),
			},
		};
		const current = yield* Ref.make<ActiveChild | null>(active);
		const destination = { ...attempt, port: 1, pid: 1, snapshot: "/fixture" };
		yield* Ref.set(routing.route, destination);
		let closureFailed = false;
		const supervisor: Supervisor = {
			current,
			requestRecovery: Effect.void,
			withdraw: Ref.set(routing.route, null).pipe(Effect.andThen(Ref.set(current, null))),
			freeze: routing.freeze,
			release: routing.release,
			resume: (value) => value.process.control("live").pipe(Effect.andThen(routing.release)),
			restart: () =>
				supervisor.start(generation).pipe(
					Effect.onError((cause) => {
						const error = Cause.findError(cause);
						return cause.reasons.length === 1 && error._tag === "Success" && Schema.is(ChildError)(error.success)
							? supervisor.withdraw.pipe(Effect.andThen(routing.release))
							: Effect.void;
					}),
					Effect.tap(() => routing.release),
				),
			operationGate: yield* Semaphore.make(1),
			callback: "http://localhost",
			run: () => Effect.never,
			recoverClosure: Effect.die("Unused recovery"),
			shutdown: Effect.void,
			assertClosure: Effect.gen(function* () {
				if (closureFailed) return yield* new ChildError({ code: "child_closure_unproven" });
			}),
			fail: () => Effect.void,
			child: {
				redact: (text: string) => text,
				traffic: routing,
				sourceError: yield* Ref.make<string | null>(null),
				channelGate: yield* Semaphore.make(1),
				attempts: yield* Ref.make<readonly ActiveChild["attempt"][]>([attempt]),
				generations: yield* Ref.make<readonly ActiveChild["generation"][]>([generation]),
				status: yield* Ref.make<ChildStatus>({
					state: "live",
					generation: 1,
					snapshot_dir: "/fixture",
					attempt: 1,
					pid: 1,
					port: 1,
					error: null,
					stderr: "",
				}),
			},
			launch: () => Effect.die("Unused launch"),
			recordAttempt: () => Effect.void,
			activate: () => Effect.void,
			retire: () =>
				Effect.gen(function* () {
					calls.push("retire");
					if (mode === "closure-failure") {
						closureFailed = true;
						return yield* new ChildError({ code: "child_closure_unproven" });
					}
				}),
			start: () =>
				Effect.gen(function* () {
					calls.push("restart");
					yield* recovery.prepare("restarted");
					const started = { ...active, attempt: { ...attempt, epoch: "restarted" } };
					yield* Ref.set(current, started);
					yield* Ref.set(routing.route, { ...destination, epoch: "restarted" });
					if (mode === "restart-failure") return yield* new ChildError({ code: "health_failed" });
					return started;
				}),
		};
		if (mode === "cutover")
			yield* sql`INSERT INTO cutover(singleton,candidate,lock_id,family,phase) VALUES(1,1,'fixture','fixture','working')`;
		if (mode === "source") yield* sql`INSERT INTO source_batches VALUES('fixture',NULL,'fixture',0,'publishing')`;
		if (mode === "restore")
			yield* sql`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES('fixture','hash','session','backup','restoring',0)`;
		if (mode === "registration-failure")
			yield* sql`CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='backup.taken' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
		const originalBackup = yield* DbOps;
		let cloneCalls = 0;
		const backup = {
			...originalBackup,
			estimatedBytes:
				mode === "quota-refusal" ? Effect.succeed(Number.MAX_SAFE_INTEGER) : originalBackup.estimatedBytes,
			clone: (destination: Parameters<typeof originalBackup.clone>[0]) =>
				Effect.suspend(() => {
					cloneCalls++;
					return originalBackup.clone(destination);
				}),
		};
		const authorized = yield* Ref.make(true);
		const capture = (yield* databaseBackup(supervisor).pipe(
			Effect.provideService(
				DbOps,
				mode === "clone-failure" || mode === "interrupt"
					? {
							...backup,
							clone: (destination) =>
								backup
									.clone(destination)
									.pipe(
										Effect.andThen(
											mode === "interrupt"
												? Effect.never
												: Effect.fail(new ChildError({ code: "cutover_backup_invalid" })),
										),
									),
						}
					: backup,
			),
		)).capture({
			reason: "hourly",
			epoch: "original",
			authorize: Effect.gen(function* () {
				if (!(yield* Ref.get(authorized))) return yield* new AuthError({ code: "session_invalid" });
			}),
		});
		const admitted = yield* Deferred.make<void>();
		const releaseWrite = yield* Deferred.make<void>();
		const writer = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* routing.awaitDestination;
				yield* Deferred.succeed(admitted, undefined);
				yield* Deferred.await(releaseWrite);
				const batch = yield* events.reserve("write", 1, "original");
				const event = {
					seq: batch.from,
					at: 1,
					type: "message.created",
					level: "info",
					actor: "fixture",
					instance: null,
					generation: 1,
					request_id: null,
					topic: null,
					message_id: null,
					payload: {},
				} satisfies typeof EventRecord.Type;
				db.transaction(() => {
					db.exec("INSERT INTO records VALUES('acknowledged WAL write')");
					db.query("INSERT INTO mutation_batches VALUES(?,?,?,?)").run(
						"write",
						batch.from,
						batch.to,
						mode === "reconciliation-failure" ? 2 : 1,
					);
					db.query("INSERT INTO outbox VALUES(?,?,?,NULL)").run(batch.from, "write", JSON.stringify(event));
				})();
				// Deliberately leave committed outbox publication for the backup's reconciliation.
			}),
		).pipe(Effect.forkChild);
		yield* Deferred.await(admitted);
		if (mode === "stale-request" || mode === "revoked-request") yield* supervisor.operationGate.take(1);
		const saving = yield* (mode === "interrupt" ? capture.pipe(Effect.timeout("100 millis")) : capture).pipe(
			Effect.exit,
			Effect.forkChild,
		);
		if (mode === "stale-request" || mode === "revoked-request") {
			yield* Effect.yieldNow;
			if (mode === "stale-request") {
				yield* Ref.set(current, { ...active, attempt: { ...attempt, epoch: "replacement" } });
				yield* Ref.set(routing.route, { ...destination, epoch: "replacement" });
			} else yield* Ref.set(authorized, false);
			yield* supervisor.operationGate.release(1);
		}
		if (
			mode !== "revoked-request" &&
			mode !== "stale-request" &&
			mode !== "cutover" &&
			mode !== "restore" &&
			mode !== "source"
		)
			yield* Deferred.await(frozen);
		yield* Deferred.succeed(releaseWrite, undefined);
		yield* Fiber.join(writer);
		const result = yield* Fiber.join(saving);
		const rows = yield* sql`SELECT * FROM backups`;
		const recordedEvents = yield* sql`SELECT event FROM events`;
		let saved: unknown = null;
		if (result._tag === "Success") {
			yield* Schema.decodeUnknownEffect(BackupRecord)(result.value);
			const copy = new Database(`${root}/backups/${result.value.id}.db`, { readonly: true });
			try {
				saved = {
					records: copy.query("SELECT * FROM records").all(),
					epoch: copy.query("SELECT epoch FROM kernel_writer").get(),
				};
			} finally {
				copy.close();
			}
		}
		const failure = result._tag === "Failure" ? Cause.findError(result.cause) : null;
		return {
			outcome: result._tag,
			quotaError:
				failure?._tag === "Success" && Schema.is(ArtifactRetentionRejected)(failure.success)
					? failure.success.code
					: null,
			cloneCalls,
			sameChild: (yield* Ref.get(current)) === active,
			files: yield* (yield* FileSystem.FileSystem)
				.readDirectory(`${root}/backups`)
				.pipe(Effect.orElseSucceed(() => [])),
			calls,
			rows,
			events: recordedEvents,
			saved,
			traffic: yield* routing.state,
			route: yield* Ref.get(routing.route),
			epoch: db.query("SELECT epoch FROM kernel_writer").get(),
			current: (yield* Ref.get(current))?.attempt.epoch ?? null,
		};
	});
	return yield* program.pipe(
		Effect.provide(
			Layer.mergeAll(
				recoveryLayer(filename),
				backupLayer({ _tag: "file", filename }, root),
				ownersLayer(root).pipe(Layer.provide(kernelBootLayer)),
				generationsLayer,
			).pipe(Layer.provideMerge(eventsLayer(Effect.void)), Layer.provideMerge(boot)),
		),
	);
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
);
main.pipe(BunRuntime.runMain);
