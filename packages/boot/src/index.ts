import { logRedactor } from "./log-redaction.ts";
import { logEvents } from "./log-events.ts";
import { migrateAppStore } from "./app-store-layout.ts";
import { sourceReverts } from "./source-revert.ts";
import { SourceRejected } from "./source-schema.ts";
import { RecoveryRejected, recoveryIntents } from "./recovery-intents.ts";
import { clientLayer } from "@comms/storage/client";
import {
	Cause,
	Config,
	Context,
	DateTime,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Path,
	Redacted,
	Ref,
	Schema,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Auth, layer as authLayer, type AuthConfig } from "./auth.ts";
import { authErrorResponse, validateAuthConfig } from "./auth-http.ts";
import type { ApplicationSource } from "./application.ts";
import { initializeBootSchema, BootIdentityUpgradePending } from "./boot-schema.ts";
import { EditAuthority, editAuthorityActive, EditLock, EditRejected, layer as editLockLayer } from "./edit-lock.ts";
import { Generations, layer as generationsLayer } from "./generations.ts";
import { SourceFiles, layer as sourceLayer } from "./source-files.ts";
import { Events, layer as eventsLayer } from "./events.ts";
import { AppRecovery, layer as recoveryLayer, remoteRecovery } from "./app-recovery.ts";
import { layer as attemptsLayer, ChildAttempts } from "./child-attempts.ts";
import { cutover } from "./cutover.ts";
import { DbOps, layer as backupLayer } from "./db-ops.ts";
import { BootHttp, type RecoveryPhase } from "./boot-http.ts";
import { PublicPages, layer as publicPagesLayer } from "./public-pages.ts";
import { layer as preparationLayer } from "./generation-preparation.ts";
import { layer as preparationProcessLayer } from "./preparation-process.ts";
import { makeBackupInventory } from "./backup-inventory.ts";
import { requestEvents } from "./request-events.ts";
import { proxy, publicRoute } from "./proxy.ts";
import { hasLegacyTopicMoves } from "./legacy-topic-moves.ts";
import { layer as kernelBootLayer } from "./kernel-boot.ts";
import { databaseBackup } from "./database-backup.ts";
import { headroomPolicyLayer, storageHeadroom } from "./storage-headroom.ts";
import { sampleStorageVolume } from "./storage-volume.ts";
import { makeEventStorage } from "./event-storage.ts";
import { databaseRestore } from "./database-restore.ts";
import { supervise } from "./supervisor.ts";
import { databaseConfiguration } from "./database-configuration.ts";
import { remoteRuntime } from "./remote-runtime.ts";
import { remoteDbOps } from "./remote-db-ops.ts";
import { makeRemoteAppInitializer } from "./app-kernel-initialize.ts";

export { remoteRuntime } from "./remote-runtime.ts";
export { databaseConfiguration } from "./database-configuration.ts";

type Handler = Effect.Effect<
	Effect.Success<typeof proxy>,
	Effect.Error<typeof proxy>,
	Exclude<Effect.Services<typeof proxy>, Auth | Events | PublicPages | BootHttp>
>;

/** Owns the listener and one scoped service graph. Recovery never withdraws authentication. */
export const boot = Effect.fn("boot")(function* (options: ApplicationSource & { readonly auth: AuthConfig }) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
	const configured = yield* databaseConfiguration(
		path.resolve(options.dataDirectory, "boot.db"),
		path.resolve(options.dataDirectory, isolated ? "store/comms.db" : "comms.db"),
	);
	yield* validateAuthConfig(options.auth);
	yield* fs.makeDirectory(options.dataDirectory, { recursive: true, mode: 0o700 });
	const configuration =
		configured._tag === "file"
			? configured
			: { ...configured, runtime: yield* remoteRuntime(configured, options.dataDirectory) };
	const remote = configuration._tag === "remote" ? configuration.runtime : undefined;
	const redact = logRedactor(
		configuration._tag === "remote"
			? [
					Redacted.value(configuration.app.url),
					Redacted.value(configuration.boot.url),
					Redacted.value(configuration.appConnection.password),
					Redacted.value(configuration.bootConnection.password),
				]
			: [],
	);
	const phase = yield* Ref.make<RecoveryPhase>({ _tag: "Recovering" });
	const restart = yield* Deferred.make<void>();
	const installed = yield* Ref.make<{ readonly handle: Handler; readonly shutdown: Effect.Effect<void> }>({
		handle: publicRoute.pipe(Effect.map((response) => response ?? authErrorResponse("boot_unavailable"))),
		shutdown: Effect.void,
	});
	const supervisor = yield* supervise(options, remote, redact);
	const { child, run, fail } = supervisor;
	const initialized = Layer.effectDiscard(
		initializeBootSchema.pipe(
			Effect.andThen(
				isolated && configuration._tag === "file" ? fs.chmod(configuration.boot.filename, 0o600) : Effect.void,
			),
		),
	).pipe(
		Layer.provideMerge(
			configuration._tag === "file"
				? clientLayer(configuration.boot)
				: Layer.succeed(SqlClient.SqlClient, configuration.runtime.bootSql),
		),
	);
	const storageServices = headroomPolicyLayer.pipe(Layer.provideMerge(initialized));
	const eventServices = Layer.unwrap(
		Effect.gen(function* () {
			const headroom = yield* storageHeadroom(options.dataDirectory);
			const volume = yield* sampleStorageVolume(headroom.sample);
			yield* volume.refresh;
			yield* volume.run.pipe(Effect.forkScoped);
			const storage = yield* makeEventStorage(volume.sample);
			// Authentication and request diagnostics still append while application recovery is refused.
			yield* storage.run.pipe(Effect.forkScoped);
			return eventsLayer(
				volume.sample.pipe(
					Effect.flatMap((sample) => headroom.reserve(sample)),
					Effect.andThen(storage.admit),
				),
				redact,
			);
		}),
	).pipe(Layer.provideMerge(storageServices));
	const sourceServices = sourceLayer(options.dataDirectory).pipe(
		Layer.provideMerge(editLockLayer.pipe(Layer.provideMerge(eventServices))),
	);
	const databaseServices =
		configuration._tag === "file"
			? Layer.mergeAll(
					backupLayer(configuration.app, options.dataDirectory),
					recoveryLayer(configuration.app.filename, options.dataDirectory),
				)
			: Layer.unwrap(
					Effect.gen(function* () {
						const runtime = configuration.runtime;
						const initialize = yield* makeRemoteAppInitializer({
							appStore: configuration.app,
							bootStore: configuration.boot,
						});
						const recovery = yield* remoteRecovery({
							appStore: configuration.app,
							bootStore: configuration.boot,
							dataDirectory: options.dataDirectory,
							withStore: runtime.withStore,
							withWriter: runtime.withWriter,
							initialize,
						});
						const backups = yield* remoteDbOps({
							store: recovery.store,
							withStore: runtime.withStore,
						});
						return Layer.mergeAll(Layer.succeed(AppRecovery, recovery), Layer.succeed(DbOps, backups));
					}),
				);
	const graph = Layer.mergeAll(
		authLayer(options.auth),
		generationsLayer,
		publicPagesLayer(options.dataDirectory),
		preparationLayer(options).pipe(Layer.provide(preparationProcessLayer)),
		attemptsLayer(options.dataDirectory, configuration._tag === "remote").pipe(Layer.provide(kernelBootLayer)),
		databaseServices,
	).pipe(Layer.provideMerge(sourceServices));

	yield* Effect.gen(function* () {
		const coordinator = yield* cutover(options, supervisor);
		const reverts = yield* sourceReverts;
		const restore = yield* databaseRestore(supervisor);
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const loggers = yield* logEvents(events, redact);
		const lifetime = yield* Effect.scope;
		const recoveryGate = yield* Semaphore.make(1);
		const supervised = yield* Ref.make(false);
		const recover = (authorize: Effect.Effect<void, unknown>, force = false) =>
			recoveryGate.withPermit(
				Effect.gen(function* () {
					yield* authorize;
					const state = yield* Ref.get(phase);
					if (state._tag === "Ready" && (yield* Ref.get(supervisor.current)))
						yield* coordinator.retryCleanup(authorize);
					if (
						state._tag === "Ready" &&
						(!force || ((yield* Ref.get(supervisor.current)) && (yield* recoveryIntents(sql)).count === 0))
					)
						return;
					if (state._tag === "Stopping") return yield* Effect.interrupt;
					yield* Ref.set(phase, { _tag: "Recovering" });
					const owners = yield* supervisor.operationGate
						.withPermit(
							Effect.gen(function* () {
								const intents = yield* recoveryIntents(sql);
								if (intents.count > 1) return yield* new RecoveryRejected({ code: "recovery_intents_conflict" });
								// Restore may have activated a child before a later recovery step failed.
								// Withdraw its route and prove closure before selecting any authoritative store again.
								const active = yield* Ref.get(supervisor.current);
								yield* supervisor.withdraw;
								if (active) yield* supervisor.retire(active);
								yield* supervisor.recoverClosure;
								// With no route and every prior owner closed, queued requests can safely receive unavailable.
								yield* supervisor.release;
								if (yield* hasLegacyTopicMoves(sql))
									return yield* new RecoveryRejected({ code: "topic_move_recovery_required" });
								yield* (yield* Generations).recover;
								yield* (yield* DbOps).recoverCopy;
								if (isolated && configuration._tag === "file")
									yield* migrateAppStore({
										dataDirectory: options.dataDirectory,
										filename: configuration.app.filename,
										allowMissingReady: yield* Effect.gen(function* () {
											const status = yield* (yield* AppRecovery).identityStatus;
											return status.adoption_phase === "ready";
										}).pipe(
											// A diagnostic cannot disarm repair; authoritative reservation still validates after journal recovery.
											Effect.catchTag("EventError", (error) =>
												error.code === "app_store_identity_invalid" ? Effect.succeed(false) : Effect.fail(error),
											),
										),
									});
								yield* (yield* DbOps).recoverStaging;
							}),
						)
						.pipe(Effect.exit);
					const source = owners._tag === "Failure" ? owners : yield* (yield* SourceFiles).recover.pipe(Effect.exit);
					yield* Ref.set(
						child.sourceError,
						source._tag === "Failure" ? redact(Cause.pretty<unknown>(source.cause)) : null,
					);
					const recovered =
						owners._tag === "Failure"
							? owners
							: yield* coordinator.recover.pipe(
									Effect.andThen(restore.recover),
									Effect.andThen(
										Effect.gen(function* () {
											yield* (yield* AppRecovery).reserveIdentity;
										}),
									),
									Effect.andThen(reverts.recover),
									Effect.andThen(source._tag === "Success" ? (yield* EditLock).recover : Effect.void),
									Effect.exit,
								);
					if (recovered._tag === "Failure") {
						yield* Ref.update(phase, (current): RecoveryPhase =>
							current._tag === "Stopping" ? current : { _tag: "Failed", cause: recovered.cause },
						);
						yield* Ref.set(child.sourceError, redact(Cause.pretty<unknown>(recovered.cause)));
						yield* fail(recovered.cause);
						return yield* Effect.failCause<unknown>(recovered.cause);
					}
					if ((yield* Ref.get(phase))._tag === "Stopping") return yield* Effect.interrupt;
					yield* Ref.set(phase, { _tag: "Ready" });
					if (!(yield* Ref.getAndSet(supervised, true)))
						yield* run(retryRecovery(Effect.void, true)).pipe(
							Effect.catchCause(fail),
							Effect.provideService(Logger.CurrentLoggers, loggers),
							Effect.forkIn(lifetime),
						);
				}).pipe(Effect.uninterruptible),
			);
		const recoveryContext = yield* Effect.context<Effect.Services<ReturnType<typeof recover>>>();
		const retryRecovery = (authorize: Effect.Effect<void, unknown>, force = false): Effect.Effect<void, unknown> =>
			recover(authorize, force).pipe(Effect.provideContext(recoveryContext));
		const context = Context.add(
			Context.pick(
				Auth,
				Events,
				PublicPages,
				ChildAttempts,
				Generations,
			)(yield* Effect.context<Auth | Events | PublicPages | ChildAttempts | Generations>()),
			BootHttp,
			{
				child,
				authConfig: options.auth,
				storeIdentity: (yield* AppRecovery).identityStatus,
				phase,
				restart: Deferred.succeed(restart, undefined).pipe(Effect.asVoid),
				requests: yield* requestEvents(events),
				backups: yield* makeBackupInventory,
				captures: yield* databaseBackup(supervisor),
				restores: {
					...restore,
					restore: (...args: Parameters<typeof restore.restore>) =>
						restore
							.restore(...args)
							.pipe(
								Effect.tap((result) =>
									result.status === "restored" ? retryRecovery(Effect.void, true).pipe(Effect.ignore) : Effect.void,
								),
							),
				},
				editing: {
					retryRecovery,
					reverts,
					source: yield* SourceFiles,
					lock: yield* EditLock,
					cutover: coordinator,
					// App filesystem effects reserve first; raw journals stay outside that interval.
					withPagePublication: (effect) =>
						Effect.gen(function* () {
							while (true) {
								const admitted = yield* supervisor.operationGate.withPermit(
									child.channelGate.withPermit(
										Effect.gen(function* () {
											if ((yield* recoveryIntents(sql)).count > 0)
												return yield* new SourceRejected({ code: "publication_pending", path: "recovery" });
											const state = yield* Ref.get(phase);
											if (state._tag !== "Ready") {
												const authority = yield* Effect.serviceOption(EditAuthority);
												if (
													state._tag !== "Failed" ||
													authority._tag !== "Some" ||
													authority.value.kind !== "human" ||
													!authority.value.repairRevert
												)
													return yield* new SourceRejected({ code: "publication_pending", path: "recovery" });
												if (!(yield* editAuthorityActive(sql, authority.value, (yield* DateTime.nowAsDate).getTime())))
													return yield* new EditRejected({ code: "authority_expired", holder: null, transitions: [] });
												if (yield* hasLegacyTopicMoves(sql))
													return yield* new RecoveryRejected({ code: "topic_move_recovery_required" });
												yield* supervisor.assertClosure;
											}
											const sequence = yield* events.state;
											if (sequence.pending_id !== null)
												return { _tag: "Waiting" as const, fence: sequence.published_through };
											return { _tag: "Published" as const, value: yield* effect };
										}),
									),
								);
								if (admitted._tag === "Published") return admitted.value;
								// Append needs the channel gate; crashed-child reconciliation needs the operation gate.
								// Release both while waiting, then recheck before capturing any source proposal.
								yield* events
									.changed(admitted.fence)
									.pipe(
										Effect.catchTag(
											"EventError",
											() => new SourceRejected({ code: "publication_pending", path: "recovery" }),
										),
									);
							}
						}),
				},
			},
		);
		// Capture services only: each request keeps its own HTTP scope, including streamed response finalizers.
		yield* Ref.set(installed, {
			handle: proxy.pipe(Effect.provideContext(Context.add(context, Logger.CurrentLoggers, loggers))),
			shutdown: supervisor.shutdown.pipe(Effect.provideContext(context), Effect.orDie),
		});
		yield* retryRecovery(Effect.void).pipe(Effect.ignore);
		return yield* Effect.never;
	}).pipe(
		Effect.provide(graph),
		Effect.catchCause((cause) =>
			Effect.gen(function* () {
				if (Cause.hasInterruptsOnly(cause)) return;
				const failure = Cause.findError(cause);
				if (failure._tag === "Success" && Schema.is(BootIdentityUpgradePending)(failure.success)) {
					const hint = failure.success.message;
					yield* Ref.update(installed, (current) => ({
						...current,
						handle: publicRoute.pipe(
							Effect.map(
								(response) =>
									response ??
									HttpServerResponse.jsonUnsafe(
										{
											error: { code: "boot_identity_upgrade_pending", message: hint, hint, retriable: false },
										},
										{ status: 409, headers: { "cache-control": "no-store" } },
									),
							),
						),
					}));
				}
				yield* Effect.logError(redact(Cause.pretty(cause)));
				yield* fail(cause);
			}),
		),
		Effect.forkScoped,
	);
	yield* HttpRouter.add("*", "/*", Ref.get(installed).pipe(Effect.flatMap((runtime) => runtime.handle))).pipe(
		(routes) => HttpRouter.serve(routes, { disableLogger: true }),
		Layer.build,
	);
	// The private publication handler and its services stay alive until all database owners close.
	yield* Effect.addFinalizer(() =>
		Ref.set(phase, { _tag: "Stopping" }).pipe(
			Effect.andThen(Ref.get(installed)),
			Effect.flatMap((runtime) => runtime.shutdown),
		),
	);
	return yield* Deferred.await(restart);
}, Effect.scoped);
