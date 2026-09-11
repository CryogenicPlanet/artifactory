import { recoveryIntents } from "./recovery-intents.ts";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Crypto, Effect, FileSystem, Layer, Path, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter } from "effect/unstable/http";
import { Auth, layer as authLayer, type AuthConfig } from "./auth.ts";
import { validateAuthConfig } from "./auth-http.ts";
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
import type { Editing } from "./edit-http.ts";
import { PublicPages, layer as publicPagesLayer } from "./public-pages.ts";
import { layer as preparationLayer } from "./generation-preparation.ts";
import { layer as preparationProcessLayer } from "./preparation-process.ts";
import { makeBackupInventory, type BackupInventory } from "./backup-inventory.ts";
import { requestEvents } from "./request-events.ts";
import { proxy } from "./proxy.ts";
import { topicMove, type TopicMove } from "./topic-move.ts";
import { moveRecovery } from "./topic-move-recovery.ts";
import { layer as topicPageMoveLayer } from "./topic-page-move.ts";
import { layer as kernelBootLayer } from "./kernel-boot.ts";
import { storageMaintenance } from "./storage-maintenance.ts";
import { databaseRestore, type DatabaseRestore } from "./database-restore.ts";
import { supervise } from "./supervisor.ts";

/** Owns the public listener and an independently supervised child.
 * The launcher supplies the entry; boot never imports app code. */
export const boot = Effect.fn("boot")(function* (options: ApplicationSource & { readonly auth: AuthConfig }) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const auth = yield* Ref.make<Auth["Service"] | null>(null);
	const events = yield* Ref.make<Events["Service"] | null>(null);
	const editing = yield* Ref.make<Editing | null>(null);
	const restores = yield* Ref.make<DatabaseRestore | null>(null);
	const publicPages = yield* Ref.make<PublicPages["Service"] | null>(null);
	const backups = yield* Ref.make<BackupInventory | null>(null);
	const requests = yield* requestEvents(events);
	const stopping = yield* Ref.make(false);
	const shutdown = yield* Ref.make<Effect.Effect<void>>(Effect.void);
	const moves = yield* Ref.make<TopicMove | null>(null);
	const sourceServices = sourceLayer(options.dataDirectory).pipe(Layer.provideMerge(editLockLayer));
	const movePagesServices = topicPageMoveLayer(options.dataDirectory).pipe(Layer.provideMerge(sourceServices));
	const supervisor = yield* supervise(options);
	const { child, run, fail } = supervisor;
	yield* Effect.gen(function* () {
		yield* validateAuthConfig(options.auth);
		yield* fs.makeDirectory(options.dataDirectory, { recursive: true, mode: 0o700 });
		return yield* Effect.gen(function* () {
			yield* initializeBootSchema;
			yield* retainEvents.pipe(Effect.forkScoped);
			return yield* Effect.gen(function* () {
				yield* Ref.set(auth, yield* Auth);
				yield* Ref.set(backups, yield* makeBackupInventory);
				yield* Ref.set(events, yield* Events);
				const context = yield* Effect.context<Events | ChildAttempts>();
				yield* Ref.set(shutdown, supervisor.shutdown.pipe(Effect.provideContext(context), Effect.orDie));
				const coordinator = yield* cutover(options, supervisor);
				const restore = yield* databaseRestore(supervisor);
				yield* Ref.set(restores, restore);
				yield* Ref.set(moves, yield* topicMove(supervisor));
				const moveRecovered = yield* Effect.gen(function* () {
					const bootSql = yield* SqlClient.SqlClient;
					const intents = yield* recoveryIntents(bootSql);
					if (intents.count > 1) return yield* Effect.die("Conflicting recovery intents");
					// No recovery path may select or mutate an authoritative store before this global check.
					yield* (yield* Generations).recover;
					yield* (yield* ChildAttempts).recover;
					if (intents.move) yield* (yield* AppRecovery).prepare(yield* (yield* Crypto.Crypto).randomUUIDv4);
				}).pipe(Effect.exit);

				const source =
					moveRecovered._tag === "Failure" ? moveRecovered : yield* (yield* SourceFiles).recover.pipe(Effect.exit);
				if (source._tag === "Failure")
					yield* Ref.set(child.sourceError, Cause.pretty<unknown>(source.cause).replace(/[a-f0-9]{64}/g, "[redacted]"));
				const recovered =
					moveRecovered._tag === "Failure"
						? moveRecovered
						: yield* coordinator.recover.pipe(
								Effect.andThen(restore.recover),
								Effect.andThen(source._tag === "Success" ? (yield* EditLock).recover : Effect.void),
								Effect.exit,
							);
				yield* Ref.set(editing, {
					writable: recovered._tag === "Success",
					source: yield* SourceFiles,
					lock: yield* EditLock,
					cutover: coordinator,
					pages: yield* PublicPages,
				});
				if (recovered._tag === "Failure") {
					yield* Ref.set(child.sourceError, Cause.pretty(recovered.cause).replace(/[a-f0-9]{64}/g, "[redacted]"));
					yield* fail(recovered.cause);
				} else {
					yield* Ref.set(publicPages, yield* PublicPages);
					yield* run.pipe(Effect.catchCause(fail), Effect.forkScoped);
					yield* (yield* storageMaintenance(supervisor)).run.pipe(Effect.forkScoped);
				}
				return yield* Effect.never;
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						generationsLayer,
						preparationLayer(options).pipe(Layer.provide(preparationProcessLayer)),
						publicPagesLayer(
							options.dataDirectory,
							supervisor.operationGate,
							child.channelGate,
							child.traffic.route,
						).pipe(Layer.provide(eventsLayer)),
						attemptsLayer(options.dataDirectory).pipe(Layer.provide(kernelBootLayer)),
						backupLayer(path.join(options.dataDirectory, "comms.db")),
						recoveryLayer(path.join(options.dataDirectory, "comms.db"), moveRecovery).pipe(
							Layer.provideMerge(Layer.mergeAll(eventsLayer, movePagesServices)),
						),
						authLayer(options.auth).pipe(Layer.provide(Layer.mergeAll(eventsLayer, editLockLayer))),
					),
				),
			);
		}).pipe(
			Effect.provide(
				SqliteClient.layer({
					filename: path.join(options.dataDirectory, "boot.db"),
					disableWAL: true,
				}),
			),
		);
	}).pipe(
		Effect.catchCause((cause) =>
			Ref.set(auth, null).pipe(
				Effect.andThen(Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause)),
				Effect.andThen(fail(cause)),
			),
		),
		Effect.forkScoped,
	);
	yield* HttpRouter.add(
		"*",
		"/*",
		proxy(child, auth, options.auth, events, editing, publicPages, requests, backups, restores, moves, stopping),
	).pipe((routes) => HttpRouter.serve(routes, { disableLogger: true }), Layer.build);
	// Close admission and retire owners while the listener can still serve their publication calls.
	yield* Effect.addFinalizer(() => Ref.set(stopping, true).pipe(Effect.andThen(Ref.get(shutdown)), Effect.flatten));
	return yield* Effect.never;
}, Effect.scoped);
