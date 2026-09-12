import { backupPath, BackupRecord } from "./backup-metadata.ts";
import { redactHex } from "./auth-primitives.ts";
import { acceptSourceRevert } from "./source-revert.ts";
import { seedSource } from "./seed-source.ts";
import { recoveryIntents } from "./recovery-intents.ts";
import { Layer, Cause, Crypto, DateTime, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { GenerationPreparation } from "./generation-preparation.ts";
import { artifactRetention, ArtifactRetentionRejected } from "./artifact-retention.ts";
import { HeadroomPolicy, storageHeadroom, StorageRejected } from "./storage-headroom.ts";
import { DbOps } from "./db-ops.ts";
import { AppRecovery } from "./app-recovery.ts";
import type { ApplicationSource } from "./application.ts";
import { ChildAttempts } from "./child-attempts.ts";
import { ChildError } from "./child-process.ts";
import { Events } from "./events.ts";
import { EditLock, EditRejected, type Ownership } from "./edit-lock.ts";
import { Generations, type Generation } from "./generations.ts";
import type { UndoSelection } from "./source-journal.ts";
import { SourceFiles } from "./source-files.ts";
import { Snapshots, layer as snapshotsLayer } from "./snapshots.ts";
import type { ActiveChild, Supervisor } from "./supervisor.ts";

export class FreezeTimeout extends Schema.TaggedError<FreezeTimeout>()("FreezeTimeout", {
	code: Schema.Literal("freeze_timeout"),
}) {}

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
	const backup = yield* DbOps;
	const events = yield* Events;
	const owners = yield* ChildAttempts;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const retention = yield* artifactRetention(options.dataDirectory, backup.dialect);
	const policy = yield* HeadroomPolicy;
	const headroom = yield* storageHeadroom(options.dataDirectory);
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
	const start = (generation: Generation) => supervisor.restart(generation).pipe(Effect.provideContext(context));
	const restore = (record: typeof Record.Type) =>
		Effect.gen(function* () {
			if (!record.backup) return yield* new ChildError({ code: "cutover_backup_missing" });
			const rows = yield* sql`SELECT * FROM backups WHERE id=${record.backup}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackupRecord))),
			);
			const artifact = rows[0];
			if (artifact && artifact.engine !== backup.dialect)
				return yield* new ChildError({ code: "backup_engine_mismatch" });
			const saved = artifact?.path;
			if (
				!artifact ||
				!saved ||
				saved !== backupPath(path, options.dataDirectory, record.backup, artifact.engine) ||
				(yield* fs.stat(saved)).type !== "File" ||
				(yield* fs.realPath(saved)) !==
					backupPath(path, yield* fs.realPath(options.dataDirectory), record.backup, artifact.engine)
			)
				return yield* new ChildError({ code: "cutover_backup_invalid" });
			if (record.phase !== "restoring") {
				yield* recovery.prepare(yield* freshEpoch, record.candidate_epoch ?? undefined);
				yield* sql`UPDATE cutover SET phase='restoring' WHERE singleton=1`;
			}
			// The replacement app must republish its grants before activation can expose its pages.
			yield* sql`DELETE FROM public_paths`;
			yield* backup.restoreInto(artifact);
			yield* recovery.prepare(yield* freshEpoch);
			yield* sql`UPDATE cutover SET phase='restored' WHERE singleton=1`;
		});
	const finish = (owner: Ownership, succeeded: boolean, release = false) =>
		Effect.gen(function* () {
			const held = (yield* lock.inspect).value;
			if (held?.id === owner.id && held.holder_family === owner.family && held.cutover_in_flight)
				yield* lock.finish(owner, { succeeded, release });
		});
	const pendingCleanup = yield* Ref.make<
		| { readonly proposal: string; readonly owner: Ownership }
		| { readonly generation: number; readonly owner: Ownership; readonly release: boolean }
		| null
	>(null);
	const completeCleanup = Effect.gen(function* () {
		const cleanup = yield* Ref.get(pendingCleanup);
		if (!cleanup) return;
		if ("proposal" in cleanup) {
			yield* sources.recover;
			yield* sources.discard(cleanup.proposal);
			yield* finish(cleanup.owner, false);
		} else {
			const record = yield* read;
			if (!record) return;
			const current = yield* Ref.get(supervisor.current);
			const route = yield* Ref.get(supervisor.child.traffic.route);
			if (
				!current ||
				current.generation.n !== cleanup.generation ||
				route?.state !== "live" ||
				route.epoch !== current.attempt.epoch
			)
				return;
			yield* backup.recoverCopy;
			yield* supervisor.assertClosure;
			if (
				record.phase !== "accepted" ||
				record.candidate !== cleanup.generation ||
				record.lock_id !== cleanup.owner.id ||
				record.family !== cleanup.owner.family
			)
				return yield* new ChildError({ code: "cutover_recovery_required" });
			// Only boot metadata changes: the accepted writer may already have acknowledged newer data.
			yield* sql.withTransaction(
				finish(cleanup.owner, true, cleanup.release).pipe(Effect.andThen(sql`DELETE FROM cutover WHERE singleton=1`)),
			);
		}
		yield* Ref.update(pendingCleanup, (current) => (current === cleanup ? null : current));
	});
	const recover = Effect.gen(function* () {
		yield* completeCleanup;
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
		yield* Ref.set(pendingCleanup, null);
		yield* Ref.set(ready, true);
	});
	const performReload = (
		owner: Ownership,
		request: {
			readonly release?: boolean;
			readonly check?: boolean;
			readonly undo?: UndoSelection;
			readonly coordinatorAgent?: string;
			readonly revertRequest?: string;
			readonly trustedSource?: { readonly directory: string; readonly agent: string };
		} = {},
	) =>
		Effect.scoped(
			Effect.gen(function* () {
				if (!(yield* Ref.get(ready)) || (yield* recoveryIntents(sql)).count > 0)
					return yield* new ChildError({ code: "cutover_recovery_required" });
				yield* supervisor.assertClosure;
				const current = yield* Ref.get(supervisor.current);
				yield* retention.prune(yield* headroom.sample, 0, current ? [current.generation.n] : []);
				yield* headroom.check();
				const proposal = yield* request.trustedSource
					? sources.prepareTrustedTree(owner, request.trustedSource.directory, request.trustedSource.agent)
					: request.undo === undefined
						? sources.prepare(owner)
						: request.undo.generation !== undefined
							? sources.prepareGeneration(owner, request.undo, request.coordinatorAgent)
							: sources.prepareUndo(owner, request.undo, request.coordinatorAgent);

				// Partial progress is retained for failure recovery; perform uses non-null local values.
				const rollback: { generation: Generation | null; candidate: ActiveChild | null; priorClosed: boolean } = {
					generation: null,
					candidate: null,
					priorClosed: false,
				};

				const prior = yield* Ref.get(supervisor.current);
				const closePrior = Effect.gen(function* () {
					if (prior && !rollback.priorClosed) {
						yield* stop(prior);
						yield* generations.retired(prior.generation.n);
						rollback.priorClosed = true;
					}
				});
				const perform = Effect.gen(function* () {
					const materialized = yield* sources.materialize(proposal);
					const reserved = yield* generations.reserve(options.entryFile);
					rollback.generation = reserved;
					const directory = path.join(options.dataDirectory, "gen");
					yield* fs.makeDirectory(directory, { recursive: true });
					const snapshots = yield* Snapshots.pipe(
						Effect.provide(
							snapshotsLayer({ sourceDirectory: path.join(materialized, "app"), generationsDirectory: directory }).pipe(
								Layer.provide(Layer.succeed(HeadroomPolicy, policy)),
							),
						),
					);
					const snapshot = yield* snapshots.create(reserved.n);
					yield* preparation.prepare(snapshot.directory, snapshot.directory);
					yield* generations.setSnapshot(reserved.n, snapshot.directory);
					const generation = { ...reserved, snapshot_dir: snapshot.directory };
					rollback.generation = generation;
					if (!(yield* fs.exists(recovery.filename))) yield* recovery.prepare(yield* freshEpoch);
					const clone = path.join(materialized, "rehearsal.db");
					yield* backup.clone({ _tag: "file", filename: clone });
					const epoch = yield* freshEpoch;
					yield* backup.prepareClone({ _tag: "file", filename: clone }, epoch);
					// Read after cloning: the boot allocator includes pruned events and outstanding reservations.
					const sequence = (yield* events.state).next;
					const rehearsed = yield* supervisor
						.launch(generation, { _tag: "file", filename: clone }, "rehearsal", sequence, epoch)
						.pipe(Effect.provideContext(context));
					const report = yield* rehearsed.process.health.pipe(
						Effect.timeout("30 seconds"),
						Effect.catchCause((cause) => {
							const reason = cause.reasons[0];
							if (cause.reasons.length !== 1 || reason?._tag !== "Fail" || !Schema.is(ChildError)(reason.error))
								return Effect.failCause(cause);
							const error = reason.error;
							return Effect.gen(function* () {
								return yield* new ChildError({
									code:
										(request.undo?.generation !== undefined || request.trustedSource !== undefined) &&
										Schema.is(ChildError)(error) &&
										error.code === "health_failed"
											? "incompatible_schema"
											: error.code,
									stderr: yield* Ref.get(rehearsed.process.stderr),
								});
							});
						}),
						Effect.ensuring(stop(rehearsed).pipe(Effect.orDie)),
					);
					yield* generations.rehearsed(generation.n, report);
					if (request.check) {
						yield* sources.discard(proposal);
						return { generation: generation.n, status: "checked" };
					}
					yield* sources.publish(proposal);
					const candidate = yield* supervisor
						.launch(generation, recovery.store, "candidate")
						.pipe(Effect.provideContext(context));
					rollback.candidate = candidate;
					yield* supervisor.freeze;
					const frozenAt = (yield* DateTime.nowAsDate).getTime();
					let priorFrozen = false;
					yield* Effect.gen(function* () {
						// A slow admitted mutation must finish before an unacknowledged freeze
						// may retire the old owner. The control deadline alone is not a drain.
						if (prior) {
							const frozen = yield* prior.process.control("frozen").pipe(Effect.result);
							priorFrozen = frozen._tag === "Success";
						}
						yield* supervisor.child.traffic.drained;
					}).pipe(
						Effect.timeoutOrElse({
							duration: "10 seconds",
							orElse: () => Effect.fail(new FreezeTimeout({ code: "freeze_timeout" })),
						}),
					);
					yield* Effect.gen(function* () {
						if (prior && !priorFrozen) yield* closePrior;
						yield* recovery.prepare(prior?.attempt.epoch ?? (yield* freshEpoch));
						const id = yield* crypto.randomUUIDv4;
						const directory = path.join(options.dataDirectory, "backups");
						yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
						const saved = backupPath(path, options.dataDirectory, id, backup.dialect);
						const fence = (yield* events.state).published_through;
						yield* retention.prune(yield* headroom.sample, yield* backup.estimatedBytes, [
							...(prior ? [prior.generation.n] : []),
							generation.n,
						]);
						const bytes = Number(yield* backup.clone({ _tag: "file", filename: saved }));
						yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation,engine) VALUES(${id},${saved},'pre-flip',${bytes},${frozenAt},${fence},${generation.n},${backup.dialect})`;
								yield* sql`UPDATE generations SET backup_id=${id} WHERE n=${generation.n}`;
								yield* events.writeBoot({
									at: frozenAt,
									type: "backup.taken",
									level: "info",
									actor: "boot",
									instance: null,
									generation: generation.n,
									request_id: null,
									topic: null,
									message_id: null,
									payload: { id, reason: "pre-flip", bytes, published_through: fence },
								});
								yield* sql`INSERT INTO cutover VALUES(1,${generation.n},${prior?.generation.n ?? null},${id},${owner.id},${owner.family},'working',${candidate.attempt.epoch})`;
							}),
						);
					});
					yield* Effect.gen(function* () {
						yield* recovery.prepare(candidate.attempt.epoch);
						yield* supervisor.recordAttempt(candidate, "starting");
						yield* owners.opened(candidate.id);
						yield* candidate.process.control("go");
						yield* candidate.process.health;
					}).pipe(Effect.timeout("5 seconds"));
					yield* sql.withTransaction(
						Effect.gen(function* () {
							yield* generations.healthy(generation.n);
							yield* sql`UPDATE cutover SET phase='accepted' WHERE singleton=1`;
							yield* acceptSourceRevert(request.revertRequest, generation.n).pipe(
								Effect.provideService(SqlClient.SqlClient, sql),
							);
						}),
					);

					yield* activate(candidate, "accepted");
					const freezeMs = (yield* DateTime.nowAsDate).getTime() - frozenAt;
					if (prior && !rollback.priorClosed) {
						yield* prior.process.control("draining").pipe(Effect.ignore);
						yield* closePrior;
					}
					yield* activate(candidate, "live");
					yield* Ref.set(pendingCleanup, {
						generation: candidate.generation.n,
						owner,
						release: request.release ?? false,
					});
					yield* completeCleanup;
					return {
						generation: candidate.generation.n,
						status: "live",
						freeze_ms: freezeMs,
					};
				});
				const result = yield* perform.pipe(Effect.interruptible, Effect.exit);
				if (result._tag === "Success") {
					yield* refresh;
					return { ...result.value, lock: (yield* lock.inspect).value };
				}
				yield* backup.recoverCopy;
				const failure = Cause.findError(result.cause);
				const incompatibleSeed =
					request.trustedSource !== undefined &&
					result.cause.reasons.length === 1 &&
					failure._tag === "Success" &&
					Schema.is(ChildError)(failure.success) &&
					failure.success.code === "incompatible_schema";
				const error =
					redactHex(Cause.pretty(result.cause)) +
					(incompatibleSeed ? "; image seed is incompatible with current data; apply a forward source fix" : "");
				const persisted = yield* read;
				const { generation: failedGeneration, candidate: failedCandidate } = rollback;
				const stderr = redactHex(
					failure._tag === "Success" && Schema.is(ChildError)(failure.success)
						? (failure.success.stderr ?? "")
						: failedCandidate
							? yield* Ref.get(failedCandidate.process.stderr)
							: "",
				);
				const acceptedGeneration =
					persisted?.phase === "accepted"
						? persisted.candidate
						: (yield* generations.list).find((item) => item.n === failedGeneration?.n && item.good === 1)?.n;
				if (acceptedGeneration !== undefined) {
					// A completed activation needs metadata cleanup only; do not replace its healthy writer.
					const current = yield* Ref.get(supervisor.current);
					const route = yield* Ref.get(supervisor.child.traffic.route);
					const needsRestart =
						current?.generation.n !== acceptedGeneration ||
						route?.state !== "live" ||
						route.epoch !== current?.attempt.epoch;
					if (needsRestart) {
						// Accepted data is never restored: public acknowledged writes may already exist.
						yield* supervisor.freeze;
						yield* supervisor.withdraw;
						if (failedCandidate) yield* stop(failedCandidate);
						yield* closePrior;
					}
					const selected = (yield* generations.list).find((item) => item.n === acceptedGeneration);
					if (!selected) return yield* new ChildError({ code: "accepted_snapshot_missing" });
					if (needsRestart) yield* start(selected);
					yield* Ref.set(pendingCleanup, { generation: selected.n, owner, release: request.release ?? false });
					yield* completeCleanup;
					return { generation: selected.n, status: "live", lock: (yield* lock.inspect).value };
				}
				if (failedCandidate) yield* stop(failedCandidate);
				if (persisted) {
					yield* supervisor.withdraw;
					yield* closePrior;
					yield* restore(persisted);
					// Restarted live jobs may publish immediately; recovery must never restore over them.
					yield* sql`DELETE FROM cutover WHERE singleton=1`;
					if (prior) yield* start(prior.generation);
				} else if (prior) {
					const restart = Effect.gen(function* () {
						yield* supervisor.withdraw;
						yield* closePrior;
						// No backup checkpoint exists: reconcile the authoritative store.
						yield* start(prior.generation);
					});
					yield* rollback.priorClosed ? restart : supervisor.resume(prior).pipe(Effect.provideContext(context));
				}
				if (!prior) yield* supervisor.release;
				// Source publication may have committed even when its completion response failed.
				// Keep the exact proposal/outcome until cleanup succeeds, including across HTTP retries.
				yield* Ref.set(pendingCleanup, { proposal, owner });
				yield* completeCleanup;
				if (failedGeneration) yield* generations.failed(failedGeneration.n, error, stderr);
				yield* refresh;
				if (
					result.cause.reasons.length === 1 &&
					failure._tag === "Success" &&
					(Schema.is(FreezeTimeout)(failure.success) ||
						Schema.is(StorageRejected)(failure.success) ||
						Schema.is(ArtifactRetentionRejected)(failure.success) ||
						(Schema.is(ChildError)(failure.success) && failure.success.code === "rehearsal_copy_timeout"))
				)
					return yield* failure.success;
				return {
					generation: failedGeneration?.n ?? null,
					status: "failed",
					error,
					stderr,
					lock: (yield* lock.inspect).value,
				};
			}),
		).pipe(
			Effect.uninterruptible,
			Effect.onError(() => supervisor.requestRecovery),
		);
	// The durable reset_pin marker also protects a human undo borrowing an editor's overlay.
	const withBorrowedLock = <A, E, R>(note: string, operation: (owner: Ownership) => Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const acquired = yield* sql.withTransaction(
				Effect.gen(function* () {
					const current = (yield* lock.inspect).value;
					const held =
						current ??
						(yield* lock.acquire(`boot:source:${yield* crypto.randomUUIDv4}`, "boot", {
							note,
						})).value;
					const owner = { id: held.id, family: held.holder_family };
					yield* lock.pin(owner, current ? 1 : 2);
					return owner;
				}),
			);
			return yield* operation(acquired).pipe(
				Effect.ensuring(
					Effect.gen(function* () {
						// Retain a pin if recovery owns it; startup resolves its journal before lock cleanup.
						if ((yield* recoveryIntents(sql)).count > 0) return;
						const current = (yield* lock.inspect).value;
						if (current?.id !== acquired.id) return;
						if (current.cutover_in_flight) yield* lock.finish(acquired, { succeeded: false });
					}).pipe(Effect.orDie),
				),
			);
		});
	const reset = <E, R>(authorize: (digest: string) => Effect.Effect<void, E, R>, agent: string) =>
		supervisor.operationGate.withPermit(
			Effect.scoped(
				Effect.gen(function* () {
					if (!(yield* Ref.get(ready)) || (yield* recoveryIntents(sql)).count > 0)
						return yield* new ChildError({ code: "cutover_recovery_required" });
					yield* supervisor.assertClosure;
					const seed = yield* seedSource(options).pipe(Effect.provideService(HeadroomPolicy, policy));
					yield* authorize(seed.digest);
					return yield* withBorrowedLock("Reset source to seed", (owner) =>
						performReload(owner, { trustedSource: { directory: seed.directory, agent } }),
					);
				}),
			).pipe(Effect.uninterruptible),
		);
	const revertHuman = <E, R>(
		selection: UndoSelection,
		identity: { readonly id: string; readonly agent: string },
		expectedLock: string | undefined,
		authorize: Effect.Effect<void, E, R>,
		revertRequest?: string,
	) =>
		supervisor.operationGate.withPermit(
			Effect.scoped(
				Effect.gen(function* () {
					yield* authorize;
					if (!(yield* Ref.get(ready)) || (yield* recoveryIntents(sql)).count > 0)
						return yield* new ChildError({ code: "cutover_recovery_required" });
					yield* supervisor.assertClosure;
					const held = (yield* lock.inspect).value;
					if (!held) return yield* new EditRejected({ code: "lock_required", holder: null, transitions: [] });
					const reloadOptions = { undo: selection, ...(revertRequest === undefined ? {} : { revertRequest }) };
					if (held.holder_family === identity.id)
						return yield* performReload({ id: expectedLock ?? "", family: identity.id }, reloadOptions);
					return yield* withBorrowedLock("Human source revert", (owner) =>
						performReload(owner, { ...reloadOptions, coordinatorAgent: identity.agent }),
					);
				}),
			).pipe(Effect.uninterruptible),
		);

	return {
		retryCleanup: <E, R>(authorize: Effect.Effect<void, E, R>) =>
			authorize.pipe(
				Effect.andThen(supervisor.operationGate.withPermit(authorize.pipe(Effect.andThen(completeCleanup)))),
			),
		reload: (owner: Ownership, reloadOptions?: Parameters<typeof performReload>[1]) =>
			supervisor.operationGate.withPermit(performReload(owner, reloadOptions)),
		reset,
		revertHuman,
		seedDigest: Effect.scoped(
			seedSource(options)
				.pipe(Effect.provideService(HeadroomPolicy, policy))
				.pipe(Effect.map((seed) => seed.digest)),
		),
		recover,
	};
});
export type Cutover = Effect.Success<ReturnType<typeof cutover>>;
