import { recoveryIntents } from "./recovery-intents.ts";
import { Cause, Crypto, DateTime, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { GenerationPreparation } from "./generation-preparation.ts";
import { AppBackup } from "./app-backup.ts";
import { AppRecovery } from "./app-recovery.ts";
import type { ApplicationSource } from "./application.ts";
import { ChildAttempts } from "./child-attempts.ts";
import { ChildError } from "./child-process.ts";
import { Events } from "./events.ts";
import { EditLock, type Ownership } from "./edit-lock.ts";
import { Generations, type Generation } from "./generations.ts";
import type { UndoSelection } from "./source-journal.ts";
import { SourceFiles } from "./source-files.ts";
import { Snapshots, layer as snapshotsLayer } from "./snapshots.ts";
import type { ActiveChild, Supervisor } from "./supervisor.ts";

const Record = Schema.Struct({
	candidate: Schema.Int,
	prior: Schema.NullOr(Schema.Int),
	backup: Schema.NullOr(Schema.String),
	lock_id: Schema.String,
	family: Schema.String,
	phase: Schema.String,
	candidate_epoch: Schema.NullOr(Schema.String),
});

/** Serializes source proposals with process recovery. Acceptance is durable before admission; rollback requires closure proof. */
export const cutover = Effect.fn("cutover")(function* (options: ApplicationSource, supervisor: Supervisor) {
	const sql = yield* SqlClient.SqlClient;
	const preparation = yield* GenerationPreparation;
	const sources = yield* SourceFiles;
	const lock = yield* EditLock;
	const generations = yield* Generations;
	const recovery = yield* AppRecovery;
	const backup = yield* AppBackup;
	const events = yield* Events;
	const owners = yield* ChildAttempts;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const context = yield* Effect.context<Generations | AppRecovery | ChildAttempts>();
	const freshEpoch = crypto.randomBytes(32).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
	const ready = yield* Ref.make(false);
	const read = sql`SELECT * FROM cutover WHERE singleton=1`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Record))),
		Effect.map((rows) => rows[0] ?? null),
	);
	const refresh = generations.list.pipe(Effect.flatMap((rows) => Ref.set(supervisor.child.generations, rows)));
	const stop = (value: ActiveChild) => supervisor.retire(value).pipe(Effect.provideContext(context));
	const activate = (value: ActiveChild, state: "accepted" | "live") =>
		supervisor.activate(value, state).pipe(Effect.provideContext(context));
	const start = (generation: Generation) => supervisor.start(generation).pipe(Effect.provideContext(context));
	const restore = (record: typeof Record.Type) =>
		Effect.gen(function* () {
			if (!record.backup) return yield* new ChildError({ code: "cutover_backup_missing" });
			const rows = yield* sql`SELECT path FROM backups WHERE id=${record.backup}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
			);
			const saved = rows[0]?.path;
			if (!saved || saved !== path.join(options.dataDirectory, "backups", `${record.backup}.db`))
				return yield* new ChildError({ code: "cutover_backup_invalid" });
			if (record.phase !== "restoring") {
				yield* recovery.prepare(yield* freshEpoch, record.candidate_epoch ?? undefined);
				yield* sql`UPDATE cutover SET phase='restoring' WHERE singleton=1`;
			}
			yield* backup.restore(saved);
			yield* recovery.prepare(yield* freshEpoch);
			yield* sql`UPDATE cutover SET phase='restored' WHERE singleton=1`;
		});
	const finish = (owner: Ownership, succeeded: boolean, release = false) =>
		Effect.gen(function* () {
			const held = (yield* lock.inspect).value;
			if (held?.id === owner.id && held.holder_family === owner.family && held.cutover_in_flight)
				yield* lock.finish(owner, { succeeded, release });
		});
	const recover = Effect.gen(function* () {
		const record = yield* read;
		if (!record) {
			yield* Ref.set(ready, true);
			return;
		}
		// Called only after keeper receipts prove every prior database owner closed.
		if (record.phase !== "accepted") yield* restore(record);
		if (record.phase === "accepted") {
			const holder = (yield* lock.inspect).value;
			if (holder?.id === record.lock_id && holder.cutover_in_flight)
				yield* lock.finish({ id: record.lock_id, family: record.family }, { succeeded: true });
		}
		yield* sql`DELETE FROM cutover WHERE singleton=1`;
		yield* Ref.set(ready, true);
	});
	const reload = (
		owner: Ownership,
		options: {
			readonly release?: boolean;
			readonly check?: boolean;
			readonly undo?: UndoSelection;
			readonly watcher?: boolean;
		} = {},
	) =>
		supervisor.operationGate.withPermit(
			Effect.scoped(
				Effect.gen(function* () {
					if (!(yield* Ref.get(ready)) || (yield* recoveryIntents(sql)).count > 0)
						return yield* new ChildError({ code: "cutover_recovery_required" });
					yield* supervisor.assertClosure;
					const proposal = yield* options.watcher
						? sources.prepareWatcher(owner)
						: options.undo === undefined
							? sources.prepare(owner)
							: options.undo.generation !== undefined
								? sources.prepareGeneration(owner, options.undo)
								: sources.prepareUndo(owner, options.undo);
					if (proposal === null) return { status: "unchanged", generation: null, lock: (yield* lock.inspect).value };
					let candidate: ActiveChild | null = null;
					let generation: Generation | null = null;

					const prior = yield* Ref.get(supervisor.current);
					let priorClosed = false;
					const closePrior = Effect.gen(function* () {
						if (prior && !priorClosed) {
							yield* stop(prior);
							priorClosed = true;
						}
					});
					const perform = Effect.gen(function* () {
						const materialized = yield* sources.materialize(proposal);
						generation = yield* generations.reserve(optionsSource.entryFile);
						const directory = path.join(optionsSource.dataDirectory, "gen");
						yield* fs.makeDirectory(directory, { recursive: true });
						const snapshots = yield* Snapshots.pipe(
							Effect.provide(
								snapshotsLayer({ sourceDirectory: path.join(materialized, "app"), generationsDirectory: directory }),
							),
						);
						const snapshot = yield* snapshots.create(generation.n);
						yield* preparation.prepare(snapshot.directory, snapshot.directory);
						yield* generations.setSnapshot(generation.n, snapshot.directory);
						generation = { ...generation, snapshot_dir: snapshot.directory };
						if (!(yield* fs.exists(recovery.filename))) yield* recovery.prepare(yield* freshEpoch);
						const clone = path.join(materialized, "rehearsal.db");
						yield* backup.clone(clone);
						const epoch = yield* freshEpoch;
						const sequence = yield* backup.prepareClone(clone, epoch);
						const rehearsed = yield* supervisor
							.launch(generation, clone, "rehearsal", sequence, epoch)
							.pipe(Effect.provideContext(context));
						yield* rehearsed.process.health.pipe(
							Effect.timeout("30 seconds"),
							Effect.catch((error) =>
								Effect.gen(function* () {
									return yield* new ChildError({
										code:
											options.undo?.generation !== undefined &&
											Schema.is(ChildError)(error) &&
											error.code === "health_failed"
												? "incompatible_schema: restore withDb using a fresh human assertion, or apply a forward source fix"
												: String(error),
										stderr: yield* Ref.get(rehearsed.process.stderr),
									});
								}),
							),
							Effect.ensuring(stop(rehearsed).pipe(Effect.orDie)),
						);
						if (options.check) {
							yield* sources.discard(proposal);
							return { generation: generation.n, status: "checked" };
						}
						yield* sources.publish(proposal);
						candidate = yield* supervisor
							.launch(generation, recovery.filename, "candidate")
							.pipe(Effect.provideContext(context));
						yield* supervisor.child.traffic.freeze;
						const frozenAt = (yield* DateTime.nowAsDate).getTime();
						const freeze = Effect.gen(function* () {
							// An uncooperative hook cannot keep the repair path frozen. Only the
							// keeper's positive closure receipt permits fencing and backup below.
							if (prior) yield* prior.process.control("frozen").pipe(Effect.catch(() => closePrior));
							yield* supervisor.child.traffic.drained;
							yield* recovery.prepare(prior?.attempt.epoch ?? (yield* freshEpoch));
							const id = yield* crypto.randomUUIDv4;
							const directory = path.join(optionsSource.dataDirectory, "backups");
							yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
							const saved = path.join(directory, `${id}.db`);
							const fence = (yield* events.state).published_through;
							const bytes = Number(yield* backup.clone(saved));
							yield* sql.withTransaction(
								Effect.gen(function* () {
									yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation) VALUES(${id},${saved},'pre-flip',${bytes},${frozenAt},${fence},${generation?.n ?? null})`;
									yield* events.writeBoot({
										at: frozenAt,
										type: "backup.taken",
										level: "info",
										actor: "boot",
										instance: null,
										generation: generation?.n ?? 0,
										request_id: null,
										topic: null,
										message_id: null,
										payload: { id, reason: "pre-flip", bytes, published_through: fence },
									});
									yield* sql`INSERT INTO cutover VALUES(1,${generation?.n ?? 0},${prior?.generation.n ?? null},${id},${owner.id},${owner.family},'working',${candidate?.attempt.epoch ?? null})`;
								}),
							);

							if (!candidate || !generation) return yield* Effect.die("Missing candidate");
							yield* recovery.prepare(candidate.attempt.epoch);
							yield* supervisor.admit(candidate, "starting");
							yield* owners.opened(candidate.id);
							yield* candidate.process.control("go");
							yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));
							yield* sql.withTransaction(
								Effect.gen(function* () {
									if (!generation) return yield* Effect.die("Missing candidate");
									yield* generations.healthy(generation.n);
									yield* sql`UPDATE cutover SET phase='accepted' WHERE singleton=1`;
								}),
							);

							yield* activate(candidate, "accepted");
							yield* supervisor.child.traffic.release;
							return (yield* DateTime.nowAsDate).getTime() - frozenAt;
						});
						const freezeMs = yield* freeze.pipe(Effect.timeout("10 seconds"));
						if (!candidate) return yield* Effect.die("Missing candidate");
						if (prior && !priorClosed) {
							yield* prior.process.control("draining").pipe(Effect.ignore);
							yield* closePrior;
						}
						yield* activate(candidate, "live");
						yield* sources
							.adoptWatcherBaseline(path.join(materialized, "app"))
							.pipe(
								Effect.catch(() =>
									Effect.logWarning(
										"Watcher baseline could not be verified; acquire the source lock and reload through the API to retry",
									),
								),
							);
						yield* finish(owner, true, options.release ?? false);
						yield* sql`DELETE FROM cutover WHERE singleton=1`;
						return {
							generation: candidate.generation.n,
							status: "live",
							freeze_ms: freezeMs,
						};
					});
					const result = yield* perform.pipe(Effect.interruptible, Effect.exit);
					const failedGeneration = ((): Generation | null => generation)();
					if (result._tag === "Success") {
						yield* refresh;
						return { ...result.value, lock: (yield* lock.inspect).value };
					}
					const error = Cause.pretty(result.cause).replace(/[a-f0-9]{64}/g, "[redacted]");
					const persisted = yield* read;
					const failedCandidate = ((): ActiveChild | null => candidate)();
					const failure = Cause.findError(result.cause);
					const stderr = (
						failure._tag === "Success" && Schema.is(ChildError)(failure.success)
							? (failure.success.stderr ?? "")
							: failedCandidate
								? yield* Ref.get(failedCandidate.process.stderr)
								: ""
					).replace(/[a-f0-9]{64}/g, "[redacted]");
					const acceptedGeneration =
						persisted?.phase === "accepted"
							? persisted.candidate
							: (yield* generations.list).find((item) => item.n === failedGeneration?.n && item.good === 1)?.n;
					if (acceptedGeneration !== undefined) {
						// Accepted data is never restored: public acknowledged writes may already exist.
						yield* supervisor.child.traffic.freeze;
						yield* Ref.set(supervisor.current, null);
						yield* Ref.set(supervisor.child.traffic.route, null);
						if (failedCandidate) yield* stop(failedCandidate);
						yield* closePrior;
						const selected = (yield* generations.list).find((item) => item.n === acceptedGeneration);
						if (!selected) return yield* new ChildError({ code: "accepted_snapshot_missing" });
						yield* start(selected);
						yield* finish(owner, true, options.release ?? false);
						yield* sql`DELETE FROM cutover WHERE singleton=1`;
						yield* supervisor.child.traffic.release;
						return { generation: selected.n, status: "live", lock: (yield* lock.inspect).value };
					}
					if (failedCandidate) yield* stop(failedCandidate);
					if (persisted) {
						yield* Ref.set(supervisor.current, null);
						yield* Ref.set(supervisor.child.traffic.route, null);
						yield* closePrior;
						yield* restore(persisted);
						// Restarted live jobs may publish immediately; recovery must never restore over them.
						yield* sql`DELETE FROM cutover WHERE singleton=1`;
						if (prior) yield* start(prior.generation);
					} else if (prior) {
						const restart = Effect.gen(function* () {
							yield* Ref.set(supervisor.current, null);
							yield* Ref.set(supervisor.child.traffic.route, null);
							yield* closePrior;
							// No backup checkpoint exists: reconcile the authoritative store.
							yield* start(prior.generation);
						});
						yield* priorClosed ? restart : prior.process.control("live").pipe(Effect.catch(() => restart));
					}
					// Source publication may have committed even when its completion response failed.
					yield* sources.recover;
					yield* sources.discard(proposal);
					yield* finish(owner, false);
					yield* supervisor.child.traffic.release;
					if (failedGeneration) yield* generations.failed(failedGeneration.n, error, stderr);
					yield* refresh;
					return {
						generation: failedGeneration?.n ?? null,
						status: "failed",
						error,
						stderr,
						lock: (yield* lock.inspect).value,
					};
				}),
			).pipe(Effect.uninterruptible),
		);
	const optionsSource = options;
	return { reload, recover };
});
export type Cutover = Effect.Success<ReturnType<typeof cutover>>;
