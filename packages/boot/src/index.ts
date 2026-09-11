import { sourceReverts } from "./source-revert.ts";
import { SourceRejected } from "./source-schema.ts";
import { recoveryIntents } from "./recovery-intents.ts";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Context, Crypto, Deferred, Effect, FileSystem, Layer, Path, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter } from "effect/unstable/http";
import { Auth, layer as authLayer, type AuthConfig } from "./auth.ts";
import { authErrorResponse, validateAuthConfig } from "./auth-http.ts";
import type { ApplicationSource } from "./application.ts";
import { initializeBootSchema } from "./boot-schema.ts";
import { EditLock, layer as editLockLayer } from "./edit-lock.ts";
import { Generations, layer as generationsLayer } from "./generations.ts";
import { SourceFiles, layer as sourceLayer } from "./source-files.ts";
import { Events, layer as eventsLayer } from "./events.ts";
import { retainEvents } from "./event-retention.ts";
import { AppRecovery, layer as recoveryLayer } from "./app-recovery.ts";
import { layer as attemptsLayer, ChildAttempts } from "./child-attempts.ts";
import { cutover } from "./cutover.ts";
import { layer as backupLayer } from "./app-backup.ts";
import { BootHttp, type RecoveryPhase } from "./boot-http.ts";
import { PublicPages, layer as publicPagesLayer } from "./public-pages.ts";
import { layer as preparationLayer } from "./generation-preparation.ts";
import { layer as preparationProcessLayer } from "./preparation-process.ts";
import { makeBackupInventory } from "./backup-inventory.ts";
import { requestEvents } from "./request-events.ts";
import { proxy, publicRoute } from "./proxy.ts";
import { moveRecovery } from "./topic-move-recovery.ts";
import { layer as topicPageMoveLayer } from "./topic-page-move.ts";
import { layer as kernelBootLayer } from "./kernel-boot.ts";
import { databaseBackup } from "./database-backup.ts";
import { headroomPolicyLayer, storageHeadroom } from "./storage-headroom.ts";
import { makeEventStorage } from "./event-storage.ts";
import { databaseRestore } from "./database-restore.ts";
import { supervise } from "./supervisor.ts";

type Handler = Effect.Effect<
	Effect.Success<typeof proxy>,
	Effect.Error<typeof proxy>,
	Exclude<Effect.Services<typeof proxy>, Auth | Events | PublicPages | BootHttp>
>;

/** Owns the listener and one scoped service graph. Recovery never withdraws authentication. */
export const boot = Effect.fn("boot")(function* (options: ApplicationSource & { readonly auth: AuthConfig }) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const phase = yield* Ref.make<RecoveryPhase>({ _tag: "Recovering" });
	const restart = yield* Deferred.make<void>();
	const installed = yield* Ref.make<{ readonly handle: Handler; readonly shutdown: Effect.Effect<void> }>({
		handle: publicRoute.pipe(Effect.map((response) => response ?? authErrorResponse("boot_unavailable"))),
		shutdown: Effect.void,
	});
	const supervisor = yield* supervise(options);
	const { child, run, fail } = supervisor;
	const initialized = Layer.effectDiscard(initializeBootSchema).pipe(
		Layer.provideMerge(
			SqliteClient.layer({ filename: path.join(options.dataDirectory, "boot.db"), disableWAL: true }).pipe(
				Layer.provide(
					Layer.effectDiscard(
						validateAuthConfig(options.auth).pipe(
							Effect.andThen(fs.makeDirectory(options.dataDirectory, { recursive: true, mode: 0o700 })),
						),
					),
				),
			),
		),
	);
	const storageServices = headroomPolicyLayer.pipe(Layer.provideMerge(initialized));
	const eventServices = Layer.unwrap(
		Effect.gen(function* () {
			const headroom = yield* storageHeadroom(options.dataDirectory);
			const storage = yield* makeEventStorage(headroom.sample);
			yield* storage.run.pipe(Effect.forkScoped);
			yield* retainEvents.pipe(Effect.forkScoped);
			return eventsLayer(headroom.check().pipe(Effect.andThen(storage.admit)));
		}),
	).pipe(Layer.provideMerge(storageServices));
	const sourceServices = sourceLayer(options.dataDirectory).pipe(
		Layer.provideMerge(editLockLayer.pipe(Layer.provideMerge(eventServices))),
	);
	const graph = Layer.mergeAll(
		authLayer(options.auth),
		generationsLayer,
		publicPagesLayer(options.dataDirectory),
		preparationLayer(options).pipe(Layer.provide(preparationProcessLayer)),
		attemptsLayer(options.dataDirectory).pipe(Layer.provide(kernelBootLayer)),
		backupLayer(path.join(options.dataDirectory, "comms.db")),
		recoveryLayer(path.join(options.dataDirectory, "comms.db"), moveRecovery).pipe(
			Layer.provide(topicPageMoveLayer(options.dataDirectory).pipe(Layer.provide(sourceServices))),
		),
	).pipe(Layer.provideMerge(sourceServices));

	yield* Effect.gen(function* () {
		const coordinator = yield* cutover(options, supervisor);
		const reverts = yield* sourceReverts;
		yield* reverts.retain.pipe(Effect.forkScoped);
		const restore = yield* databaseRestore(supervisor);
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Events;
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
				phase,
				restart: Deferred.succeed(restart, undefined).pipe(Effect.asVoid),
				requests: yield* requestEvents(events),
				backups: yield* makeBackupInventory,
				captures: yield* databaseBackup(supervisor),
				restores: restore,
				editing: {
					reverts,
					source: yield* SourceFiles,
					lock: yield* EditLock,
					cutover: coordinator,
					// App filesystem effects reserve first; raw journals stay outside that interval.
					withPagePublication: (effect) =>
						supervisor.operationGate.withPermit(
							child.channelGate.withPermit(
								Effect.gen(function* () {
									if ((yield* recoveryIntents(sql)).count > 0 || (yield* events.state).pending_id !== null)
										return yield* new SourceRejected({ code: "publication_pending", path: "recovery" });
									return yield* effect;
								}),
							),
						),
				},
			},
		);
		// Capture services only: each request keeps its own HTTP scope, including streamed response finalizers.
		yield* Ref.set(installed, {
			handle: proxy.pipe(Effect.provideContext(context)),
			shutdown: supervisor.shutdown.pipe(Effect.provideContext(context), Effect.orDie),
		});
		const owners = yield* Effect.gen(function* () {
			const intents = yield* recoveryIntents(sql);
			if (intents.count > 1) return yield* Effect.die("Conflicting recovery intents");
			// No recovery selects or mutates an authoritative store before this global check.
			yield* (yield* Generations).recover;
			yield* (yield* ChildAttempts).recover;
			if (intents.move) yield* (yield* AppRecovery).prepare(yield* (yield* Crypto.Crypto).randomUUIDv4);
		}).pipe(Effect.exit);
		const source = owners._tag === "Failure" ? owners : yield* (yield* SourceFiles).recover.pipe(Effect.exit);
		if (source._tag === "Failure")
			yield* Ref.set(child.sourceError, Cause.pretty<unknown>(source.cause).replace(/[a-f0-9]{64}/g, "[redacted]"));
		const recovered =
			owners._tag === "Failure"
				? owners
				: yield* coordinator.recover.pipe(
						Effect.andThen(restore.recover),
						Effect.andThen(reverts.recover),
						Effect.andThen(source._tag === "Success" ? (yield* EditLock).recover : Effect.void),
						Effect.exit,
					);
		if (recovered._tag === "Failure") {
			yield* Ref.update(phase, (current): RecoveryPhase =>
				current._tag === "Stopping" ? current : { _tag: "Failed", cause: recovered.cause },
			);
			yield* Ref.set(child.sourceError, Cause.pretty(recovered.cause).replace(/[a-f0-9]{64}/g, "[redacted]"));
			yield* fail(recovered.cause);
		} else {
			yield* Ref.update(phase, (current): RecoveryPhase => (current._tag === "Stopping" ? current : { _tag: "Ready" }));
			yield* run.pipe(Effect.catchCause(fail), Effect.forkScoped);
		}
		return yield* Effect.never;
	}).pipe(
		Effect.provide(graph),
		Effect.catchCause((cause) =>
			Effect.gen(function* () {
				if (Cause.hasInterruptsOnly(cause)) return;
				yield* Effect.logError(cause);
				yield* fail(cause);
			}),
		),
		Effect.forkScoped,
	);
	yield* HttpRouter.add(
		"*",
		"/*",
		child.metrics.request.pipe(
			Effect.andThen(Ref.get(installed)),
			Effect.flatMap((runtime) => runtime.handle),
		),
	).pipe((routes) => HttpRouter.serve(routes, { disableLogger: true }), Layer.build);
	// The private publication handler and its services stay alive until all database owners close.
	yield* Effect.addFinalizer(() =>
		Ref.set(phase, { _tag: "Stopping" }).pipe(
			Effect.andThen(Ref.get(installed)),
			Effect.flatMap((runtime) => runtime.shutdown),
		),
	);
	return yield* Deferred.await(restart);
}, Effect.scoped);
