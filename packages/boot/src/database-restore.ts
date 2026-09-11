import { recoveryIntents } from "./recovery-intents.ts";
import { Cause, Crypto, DateTime, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { artifactRetention, ArtifactRetentionRejected } from "./artifact-retention.ts";
import { storageHeadroom, StorageRejected } from "./storage-headroom.ts";
import { AppBackup } from "./app-backup.ts";
import { AppRecovery } from "./app-recovery.ts";
import { Auth } from "./auth.ts";
import { BackupRecord } from "./backup-metadata.ts";
import { ChildAttempts } from "./child-attempts.ts";
import { ChildError } from "./child-process.ts";
import { DatabaseRestoreRequest, type RestoreSelection } from "./database-restore-schema.ts";
import { generationSource } from "./generation-source.ts";
import { prepareRestoreGeneration } from "./restore-generation.ts";
import { SourceFiles } from "./source-files.ts";
import { EditLock } from "./edit-lock.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { Generations } from "./generations.ts";
import type { ActiveChild, Supervisor } from "./supervisor.ts";

/** Select durable restore evidence before opening the app store. Accepted requests never replace it again. */
export const databaseRestore = Effect.fn("databaseRestore")(function* (supervisor: Supervisor) {
	const sql = yield* SqlClient.SqlClient;
	const auth = yield* Auth;
	const backup = yield* AppBackup;
	const recovery = yield* AppRecovery;
	const owners = yield* ChildAttempts;
	const generations = yield* Generations;
	const lock = yield* EditLock;
	const sources = yield* SourceFiles;
	const events = yield* Events;
	const crypto = yield* Crypto.Crypto;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const retention = yield* artifactRetention(path.dirname(recovery.filename));
	const headroom = yield* storageHeadroom(path.dirname(recovery.filename));
	const context = yield* Effect.context<Generations | AppRecovery | ChildAttempts>();
	const preparationContext = yield* Effect.context<Effect.Services<ReturnType<typeof prepareRestoreGeneration>>>();
	const ready = yield* Ref.make(false);
	const freshEpoch = crypto.randomBytes(32).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
	const read = (id: string) =>
		sql`SELECT * FROM db_restore_requests WHERE proof_id=${id}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DatabaseRestoreRequest))),
			Effect.flatMap((rows) =>
				rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new ChildError({ code: "restore_record_missing" })),
			),
		);
	const saved = (id: string) =>
		Effect.gen(function* () {
			const rows = yield* sql`SELECT * FROM backups WHERE id=${id}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackupRecord))),
			);
			const row = rows[0];
			const directory = path.join(path.dirname(recovery.filename), "backups");
			if (
				!row ||
				row.published_through === null ||
				row.published_through < 0 ||
				row.path !== path.join(directory, `${id}.db`) ||
				(yield* fs.realPath(row.path)) !==
					path.join(yield* fs.realPath(path.dirname(recovery.filename)), "backups", `${id}.db`) ||
				(yield* fs.stat(row.path)).type !== "File"
			)
				return yield* new ChildError({ code: "restore_backup_invalid" });
			return row;
		});
	const releaseLock = (record: DatabaseRestoreRequest) =>
		sql.withTransaction(
			Effect.gen(function* () {
				if (!record.lock_id || !record.lock_family) return;
				const held = (yield* lock.inspect).value;
				if (held?.id === record.lock_id && held.cutover_in_flight)
					yield* lock.finish(
						{ id: record.lock_id, family: record.lock_family },
						{
							succeeded: record.lock_owned === 1,
							release: record.lock_owned === 1,
						},
					);
				yield* sql`UPDATE db_restore_requests SET lock_id=NULL,lock_family=NULL WHERE proof_id=${record.proof_id}`;
			}),
		);
	const receipt = (record: DatabaseRestoreRequest) => ({
		status: record.phase === "restored" ? "restored" : "failed",
		backup: record.backup,
		safety_backup: record.safety_backup,
		generation: record.generation,
		...(record.source_generation === null ? {} : { source_generation: record.source_generation }),
		restored_to_seq: record.restored_to_seq,
		event_seq: record.event_seq,
		...(record.failure ? { error: record.failure } : {}),
	});
	const stop = (active: ActiveChild) => supervisor.retire(active).pipe(Effect.provideContext(context));
	const unroute = Effect.gen(function* () {
		yield* Ref.set(supervisor.current, null);
		yield* Ref.set(supervisor.child.traffic.route, null);
	});
	const release = Effect.gen(function* () {
		yield* supervisor.child.traffic.requests.release;
		yield* supervisor.child.traffic.release;
	});
	const selectGeneration = (record: DatabaseRestoreRequest) =>
		Effect.gen(function* () {
			const n =
				record.phase === "failed" || record.phase === "rollback"
					? (record.prior_generation ?? record.generation)
					: record.generation;
			const selected = (yield* generations.list).find(
				(item) =>
					item.n === n && (item.good === 1 || (record.phase === "restoring" && record.source_generation !== null)),
			);
			if (!selected) return yield* new ChildError({ code: "restore_snapshot_missing" });
			return selected;
		});
	const completeSource = (record: DatabaseRestoreRequest) =>
		Effect.gen(function* () {
			if (record.source_generation !== null && record.phase === "restored" && record.source_batch === null)
				return yield* new ChildError({ code: "restore_record_missing" });
			if (record.source_batch !== null) yield* sources.completePublication(record.source_batch);
		});

	const rollback = (record: DatabaseRestoreRequest) =>
		Effect.gen(function* () {
			if (!record.safety_backup) return yield* new ChildError({ code: "restore_safety_backup_missing" });
			if (record.phase !== "rollback") {
				// A candidate may have opened the selected store. Reconcile that store before selecting its replacement.
				yield* recovery.prepare(yield* freshEpoch, record.candidate_epoch ?? undefined);
				yield* sql`UPDATE db_restore_requests SET phase='rollback' WHERE proof_id=${record.proof_id}`;
			}
			// The replacement app must republish its grants before activation can expose its pages.
			yield* sql`DELETE FROM public_paths`;
			yield* backup.restore((yield* saved(record.safety_backup)).path);
			yield* recovery.prepare(yield* freshEpoch);
			yield* sql`UPDATE db_restore_requests SET phase='failed',failure='restore_not_accepted' WHERE proof_id=${record.proof_id}`;
			yield* releaseLock(record);
		});
	const install = (record: DatabaseRestoreRequest) =>
		Effect.uninterruptibleMask((interruptible) =>
			Effect.gen(function* () {
				const generation = yield* selectGeneration(record);
				const target = yield* saved(record.backup);
				if (target.published_through !== record.restored_to_seq)
					return yield* new ChildError({ code: "restore_backup_changed" });
				// The replacement app must republish its grants before activation can expose its pages.
				yield* sql`DELETE FROM public_paths`;
				yield* backup.restore(target.path);
				const epoch = yield* freshEpoch;
				yield* recovery.prepare(epoch);
				// From here, candidate effects belong to the working store. A crash must reconcile it before rollback.
				yield* sql`UPDATE db_restore_requests SET phase='working',candidate_epoch=${epoch} WHERE proof_id=${record.proof_id}`;
				const candidate = yield* supervisor
					.launch(generation, recovery.filename, "candidate", undefined, epoch)
					.pipe(Effect.provideContext(context));
				const accepted = yield* interruptible(
					Effect.gen(function* () {
						yield* supervisor.recordAttempt(candidate, "starting");
						yield* owners.opened(candidate.id);
						yield* candidate.process.control("go");
						yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));
						yield* recovery.prepare(epoch, epoch);
						const acceptance = sql.withTransaction(
							Effect.gen(function* () {
								yield* generations.healthy(generation.n);
								const eventSeq = (yield* events.state).next;
								yield* events.writeBoot({
									at: (yield* DateTime.nowAsDate).getTime(),
									type: "db.restored",
									level: "info",
									actor: "rahul",
									instance: record.session_id,
									generation: generation.n,
									request_id: null,
									topic: null,
									message_id: null,
									payload: {
										backup: record.backup,
										restored_to_seq: record.restored_to_seq,
										...(record.source_generation === null ? {} : { source_generation: record.source_generation }),
									},
								});
								yield* sql`UPDATE db_restore_requests SET phase='restored',event_seq=${eventSeq} WHERE proof_id=${record.proof_id}`;
							}),
						);
						if (record.source_generation === null) yield* acceptance;
						else {
							if (!record.lock_id || !record.lock_family)
								return yield* new ChildError({ code: "restore_record_missing" });
							const selectedSource = yield* generationSource(path.dirname(recovery.filename), generation.n).pipe(
								Effect.provideContext(preparationContext),
							);
							// The journal and acceptance commit together; disposal is registered before interruption can observe a proposal.
							yield* Effect.acquireUseRelease(
								sources.prepareTrustedTree({ id: record.lock_id, family: record.lock_family }, selectedSource, "rahul"),
								(proposal) =>
									sources.publishWithAcceptance(
										proposal,
										acceptance.pipe(
											Effect.andThen(
												sql`UPDATE db_restore_requests SET source_batch=${proposal} WHERE proof_id=${record.proof_id}`,
											),
											Effect.asVoid,
										),
									),
								(proposal) => sources.discard(proposal).pipe(Effect.ignore),
							);
						}
						yield* supervisor.activate(candidate, "live").pipe(Effect.provideContext(context));
					}),
				).pipe(Effect.exit);
				if (accepted._tag === "Failure") {
					yield* unroute;
					yield* stop(candidate);
					return yield* Effect.failCause(accepted.cause);
				}
				yield* releaseLock(record);
			}),
		);
	const restart = (record: DatabaseRestoreRequest) =>
		Effect.gen(function* () {
			yield* completeSource(record);
			if (yield* Ref.get(supervisor.current)) return;
			yield* supervisor.start(yield* selectGeneration(record)).pipe(Effect.provideContext(context));
		});
	const resume = (record: DatabaseRestoreRequest) =>
		Effect.gen(function* () {
			if (record.phase === "restoring") {
				const installed = yield* install(record).pipe(Effect.interruptible, Effect.exit);
				if (installed._tag === "Success") return;
				yield* supervisor.assertClosure;
				const latest = yield* read(record.proof_id);
				if (latest.phase === "restored") {
					yield* completeSource(latest);
					yield* releaseLock(latest);
					yield* restart(latest);
					return;
				}
				if (latest.phase === "restoring" && (yield* events.state).pending_id === null) {
					// No candidate opened this store and no reservation exists; a corrupt target can safely return to the fresh copy.
					yield* sql`UPDATE db_restore_requests SET phase='rollback' WHERE proof_id=${record.proof_id}`;
				} else if (latest.phase !== "working") return yield* Effect.failCause(installed.cause);
				yield* rollback(yield* read(record.proof_id));
				yield* restart(yield* read(record.proof_id));
			} else if (record.phase === "working" || record.phase === "rollback") {
				yield* rollback(record);
				yield* restart(yield* read(record.proof_id));
			} else if (record.phase === "authorized") {
				yield* sql`UPDATE db_restore_requests SET phase='failed',failure='restore_interrupted_before_selection' WHERE proof_id=${record.proof_id}`;
				yield* releaseLock(record);
			} else {
				yield* completeSource(record);
				yield* releaseLock(record);
			}
		});
	const recover = supervisor.operationGate.withPermit(
		Effect.gen(function* () {
			const records =
				yield* sql`SELECT * FROM db_restore_requests WHERE phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DatabaseRestoreRequest))),
				);
			for (const record of records) yield* resume(record);
			yield* Ref.set(ready, true);
		}),
	);
	const restore = (params: RestoreSelection, proof: AssertionProof, sessionId: string) =>
		supervisor.operationGate.withPermit(
			Effect.gen(function* () {
				const pending = yield* recoveryIntents(sql);
				if (!(yield* Ref.get(ready)) || pending.cutover || pending.move)
					return yield* new ChildError({ code: "restore_recovery_required" });
				if (
					pending.source &&
					!(yield* sql`SELECT proof_id FROM db_restore_requests
					WHERE phase='restored' AND source_batch IN (SELECT id FROM source_batches WHERE state='publishing')
					AND (proof_id=${proof.id} OR (session_id=${sessionId} AND idempotency_key=${params.idempotency_key ?? null}))`)
						.length
				)
					return yield* new ChildError({ code: "restore_recovery_required" });
				yield* supervisor.assertClosure;
				const record = yield* auth.authorizeDatabaseRestore(params, proof, sessionId);
				if (record.phase === "restored" || record.phase === "failed") {
					yield* completeSource(record);
					if (record.phase === "restored" && record.source_generation !== null && record.lock_id !== null)
						yield* restart(record);
					yield* releaseLock(record);
					return receipt(record);
				}
				if (pending.source || record.phase !== "authorized")
					return yield* new ChildError({ code: "restore_recovery_required" });
				const prior = yield* Ref.get(supervisor.current);
				let priorClosed = false;
				const close = Effect.gen(function* () {
					yield* unroute;
					if (prior && !priorClosed) {
						yield* stop(prior);
						priorClosed = true;
					}
				});
				const prepare = Effect.gen(function* () {
					const target = yield* saved(record.backup);
					const estimated = yield* backup.estimatedBytes;
					yield* retention.prune(yield* headroom.sample, estimated, prior ? [prior.generation.n] : []);
					// Reserve room for both the safety copy and temporary restore copy before selecting replacement.
					yield* headroom.check(estimated + target.bytes);
					const generation =
						prior?.generation ??
						(yield* generations.list).find((item) => item.good === 1 && item.snapshot_dir !== null);
					if (!generation) return yield* new ChildError({ code: "restore_snapshot_missing" });
					// Pin another holder without consuming their staging; record and pin commit together.
					yield* sql.withTransaction(
						Effect.gen(function* () {
							const current = (yield* lock.inspect).value;
							const held =
								current ??
								(yield* lock.acquire(`boot:restore:${record.proof_id}`, "boot", { note: "Database restore" })).value;
							yield* lock.pin({ id: held.id, family: held.holder_family });
							yield* sql`UPDATE db_restore_requests SET generation=${generation.n},prior_generation=${generation.n},lock_id=${held.id},lock_family=${held.holder_family},lock_owned=${current ? 0 : 1} WHERE proof_id=${record.proof_id}`;
						}),
					);
					if (record.source_generation !== null)
						yield* prepareRestoreGeneration(yield* read(record.proof_id), target.path, supervisor).pipe(
							Effect.provideContext(preparationContext),
						);
					yield* supervisor.child.traffic.freeze;
					if (prior) yield* prior.process.control("frozen").pipe(Effect.catch(() => close));
					yield* supervisor.child.traffic.drained.pipe(Effect.timeout("5 seconds"));
					yield* recovery.prepare(prior?.attempt.epoch ?? (yield* freshEpoch));
					const id = yield* crypto.randomUUIDv4;
					const directory = path.join(path.dirname(recovery.filename), "backups");
					yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
					const filename = path.join(directory, `${id}.db`);
					const fence = (yield* events.state).published_through;
					const frozenEstimate = yield* backup.estimatedBytes;
					yield* retention.prune(yield* headroom.sample, frozenEstimate, [generation.n]);
					yield* headroom.check(frozenEstimate + target.bytes);
					const bytes = Number(yield* backup.clone(filename));
					const at = (yield* DateTime.nowAsDate).getTime();
					yield* sql.withTransaction(
						Effect.gen(function* () {
							yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation)
						VALUES(${id},${filename},'pre-restore',${bytes},${at},${fence},${generation.n})`;
							yield* events.writeBoot({
								at,
								type: "backup.taken",
								level: "info",
								actor: "boot",
								instance: null,
								generation: generation.n,
								request_id: null,
								topic: null,
								message_id: null,
								payload: { id, reason: "pre-restore", bytes, published_through: fence },
							});
							yield* sql`UPDATE db_restore_requests SET safety_backup=${id} WHERE proof_id=${record.proof_id}`;
						}),
					);
					yield* supervisor.child.traffic.requests.freeze;
					// Retiring the child closes even stalled reads. Boot-owned SQLite readers share operationGate.
					yield* supervisor.child.traffic.requests.drained.pipe(Effect.timeout("5 seconds"), Effect.ignore);
					yield* close;
					yield* supervisor.assertClosure;
					yield* sql`UPDATE db_restore_requests SET phase='restoring' WHERE proof_id=${record.proof_id}`;
				});
				return yield* Effect.gen(function* () {
					const prepared = yield* prepare.pipe(Effect.interruptible, Effect.exit);
					if (prepared._tag === "Failure") {
						yield* supervisor.assertClosure;
						const latest = yield* read(record.proof_id);
						if (latest.phase !== "authorized") return yield* Effect.failCause(prepared.cause);
						// No replacement was selected. Resume the authoritative current store, never the requested backup.
						if (latest.generation !== null) yield* close;
						const cause = Cause.findError(prepared.cause);
						const failure =
							cause._tag === "Success" &&
							(Schema.is(StorageRejected)(cause.success) || Schema.is(ArtifactRetentionRejected)(cause.success))
								? cause.success.code
								: "restore_preparation_failed";
						yield* sql`UPDATE db_restore_requests SET phase='failed',failure=${failure} WHERE proof_id=${record.proof_id}`;
						yield* releaseLock(latest);
						if (latest.generation !== null) yield* restart(yield* read(record.proof_id));
						return receipt(yield* read(record.proof_id));
					}
					yield* resume(yield* read(record.proof_id));
					return receipt(yield* read(record.proof_id));
				}).pipe(
					// Reopening admission is safe only after failed coordinator work has lost its route.
					Effect.tapCause(() =>
						Effect.gen(function* () {
							const active = yield* Ref.get(supervisor.current);
							yield* unroute;
							if (active) yield* stop(active);
						}),
					),
					Effect.ensuring(release),
				);
			}).pipe(
				Effect.uninterruptible,
				Effect.tapCause((cause) =>
					Effect.gen(function* () {
						if (!(yield* Ref.get(supervisor.current))) yield* supervisor.fail(cause);
					}),
				),
			),
		);
	return { restore, recover };
});
export type DatabaseRestore = Effect.Success<ReturnType<typeof databaseRestore>>;
