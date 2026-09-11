import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Cause, Effect, FileSystem, Layer, Path, Ref } from "effect";
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
import { layer as recoveryLayer } from "./app-recovery.ts";
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
import { layer as kernelBootLayer } from "./kernel-boot.ts";
import { storageUsage } from "./storage-usage.ts";
import { storageMaintenance } from "./storage-maintenance.ts";
import { supervise } from "./supervisor.ts";

/** Owns the public listener and an independently supervised child.
 * The launcher supplies the entry; boot never imports app code. */
export const boot = Effect.fn("boot")(function* (options: ApplicationSource & { readonly auth: AuthConfig }) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const auth = yield* Ref.make<Auth["Service"] | null>(null);
	const events = yield* Ref.make<Events["Service"] | null>(null);
	const editing = yield* Ref.make<Editing | null>(null);
	const publicPages = yield* Ref.make<PublicPages["Service"] | null>(null);
	const backups = yield* Ref.make<BackupInventory | null>(null);
	const requests = yield* requestEvents(events);
	const storage = yield* storageUsage(options.dataDirectory);
	const supervisor = yield* supervise(options);
	const { child, run, fail } = supervisor;
	yield* Effect.gen(function* () {
		yield* validateAuthConfig(options.auth);
		yield* fs.makeDirectory(options.dataDirectory, { recursive: true, mode: 0o700 });
		yield* storage.run.pipe(Effect.forkScoped);
		return yield* Effect.gen(function* () {
			yield* initializeBootSchema;
			yield* retainEvents.pipe(Effect.forkScoped);
			return yield* Effect.gen(function* () {
				yield* Ref.set(auth, yield* Auth);
				yield* Ref.set(backups, yield* makeBackupInventory);
				yield* Ref.set(events, yield* Events);
				yield* (yield* Generations).recover;
				const coordinator = yield* cutover(options, supervisor);
				yield* Ref.set(editing, {
					source: yield* SourceFiles,
					lock: yield* EditLock,
					cutover: coordinator,
					pages: yield* PublicPages,
				});
				const source = yield* (yield* SourceFiles).recover.pipe(Effect.exit);
				if (source._tag === "Failure")
					yield* Ref.set(child.sourceError, Cause.pretty(source.cause).replace(/[a-f0-9]{64}/g, "[redacted]"));
				const recovered = yield* (yield* ChildAttempts).recover.pipe(
					Effect.andThen(coordinator.recover),
					Effect.andThen(source._tag === "Success" ? (yield* EditLock).recover : Effect.void),
					Effect.exit,
				);
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
						publicPagesLayer(options.dataDirectory, supervisor.operationGate, child.channelGate).pipe(
							Layer.provide(eventsLayer),
						),
						attemptsLayer(options.dataDirectory).pipe(Layer.provide(kernelBootLayer)),
						backupLayer(path.join(options.dataDirectory, "comms.db")),
						recoveryLayer(path.join(options.dataDirectory, "comms.db")).pipe(Layer.provideMerge(eventsLayer)),
						sourceLayer(options.dataDirectory).pipe(Layer.provideMerge(editLockLayer)),
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
		proxy(child, auth, options.auth, events, editing, publicPages, requests, backups, storage.current),
	).pipe((routes) => HttpRouter.serve(routes, { disableLogger: true }), Layer.build);
	return yield* Effect.never;
});
