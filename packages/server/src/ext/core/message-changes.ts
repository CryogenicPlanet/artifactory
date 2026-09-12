import { Deferred, Effect, Ref } from "effect";
import type { ExtensionCapabilities } from "../../kernel/extension-capabilities.ts";
import { KernelError } from "../../kernel/boot-channel.ts";

/** One core-owned follower suppresses request/reservation diagnostics; unknown events still invalidate reads. */
export const makeMessageChanges = Effect.gen(function* () {
	const scope = yield* Effect.scope;
	const started = yield* Ref.make(false);
	const relevant = yield* Ref.make(0);
	const failure = yield* Ref.make<KernelError | null>(null);
	const signal = yield* Ref.make(yield* Deferred.make<void>());
	const notify = Effect.gen(function* () {
		const next = yield* Deferred.make<void>();
		yield* Deferred.succeed(yield* Ref.getAndSet(signal, next), undefined);
	}).pipe(Effect.uninterruptible);
	const register = (events: ExtensionCapabilities["events"], since: number) =>
		Effect.gen(function* () {
			if (yield* Ref.getAndSet(started, true)) return;
			const follow = Effect.gen(function* () {
				let cursor = since;
				while (true) {
					const result = yield* Effect.gen(function* () {
						const page = yield* events.query({
							since: cursor,
							limit: 200,
							wait: 60,
						});
						if (page.drained) return yield* new KernelError({ code: "boot_unavailable" });
						const latest = page.items.reduce(
							(seq, item) =>
								item.type === "http.request" || item.type === "seq.reserved" ? seq : Math.max(seq, item.seq),
							0,
						);
						// The query must observe this publication in its cached global fence before waking.
						if (latest > 0) yield* events.changed(latest - 1);
						cursor = page.cursor;
						yield* Ref.set(failure, null);
						if (latest > (yield* Ref.get(relevant))) {
							yield* Ref.set(relevant, latest);
							yield* notify;
						}
					}).pipe(Effect.result);
					if (result._tag === "Failure") {
						yield* Ref.set(failure, result.failure);
						yield* notify;
						yield* Effect.sleep("1 second");
					}
				}
			});
			yield* follow.pipe(Effect.forkIn(scope));
		}).pipe(Effect.uninterruptible);
	const changed = (after: number) =>
		Effect.gen(function* () {
			while (true) {
				const pending = yield* Ref.get(signal);
				const error = yield* Ref.get(failure);
				if (error) return yield* error;
				const current = yield* Ref.get(relevant);
				if (current > after) return current;
				yield* Deferred.await(pending);
			}
		});
	return { register, changed };
});
