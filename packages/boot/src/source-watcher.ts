import { Effect, FileSystem, Path, Ref, Stream } from "effect";
import type { Cutover } from "./cutover.ts";
import { EditLock } from "./edit-lock.ts";
import { SourceFiles } from "./source-files.ts";
import { validSourcePath } from "./source-io.ts";

/** Best-effort volume notifications plus reconciliation; never changes external bytes.
 * A failed fingerprint is attempted once until the source changes or boot restarts. */
export const watchSource = Effect.fn("watchSource")(function* (dataDirectory: string, coordinator: Cutover) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const source = yield* SourceFiles;
	const lock = yield* EditLock;
	const attempted = yield* Ref.make<string | null>(null);
	const warned = yield* Ref.make<string | null>(null);
	const directory = path.join(yield* fs.realPath(dataDirectory), "app");
	const reconcile = Effect.gen(function* () {
		const observed = yield* source.observe;
		if (observed.changes.length === 0 || observed.fingerprint === (yield* Ref.get(attempted))) return;
		const held = (yield* lock.acquire("boot:watcher", "watcher", { note: "Direct volume source edit", ttl: 60 })).value;
		const owner = { id: held.id, family: held.holder_family };
		yield* Effect.gen(function* () {
			const result = yield* coordinator.reload(owner, { watcher: true, release: true });
			// A concurrent external edit receives its own attempt on the next reconciliation.
			yield* Ref.set(attempted, observed.fingerprint);
			if (result.status === "failed")
				yield* Effect.logWarning("Direct source edit failed rehearsal or cutover; edit app source to retry");
		}).pipe(
			Effect.ensuring(
				Effect.gen(function* () {
					const current = (yield* lock.inspect).value;
					if (current?.id === owner.id && current.cutover_in_flight === 0) yield* lock.release(owner);
				}).pipe(Effect.ignore),
			),
		);
	}).pipe(
		Effect.catchTags({
			EditRejected: () => Effect.void,
			SourceRejected: (error) =>
				Effect.gen(function* () {
					if (error.code === (yield* Ref.get(warned))) return;
					yield* Ref.set(warned, error.code);
					if (error.code === "watcher_baseline_missing")
						yield* Effect.logWarning(
							"Source watcher disabled: legacy app has no authoritative baseline; acquire the source lock and POST /api/reload?release=1 {} to establish a verified baseline",
						);
					else if (error.code !== "publication_pending")
						yield* Effect.logWarning(
							`Source watcher refused source (${error.code}); repair invalid or concurrently changed app files`,
						);
				}),
		}),
		Effect.catch(() => Effect.logWarning("Source watcher reconciliation failed; retrying")),
	);
	// The initial seed may still be preparing when this scoped fiber begins.
	while (!(yield* fs.exists(directory))) yield* Effect.sleep("100 millis");
	const notifications = fs.watch(directory, { recursive: true }).pipe(
		Stream.filter((event) => validSourcePath(`app/${path.relative(directory, event.path)}`)),
		Stream.debounce("100 millis"),
		Stream.catch(() => Stream.empty),
	);
	// Periodic inventory catches missed atomic renames and retries after another editor releases its lock.
	yield* reconcile;
	yield* Stream.merge(notifications, Stream.tick("1 second")).pipe(Stream.runForEach(() => reconcile));
});
