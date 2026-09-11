import { Clock, Effect } from "effect";
import type { Envelope } from "./messages.ts";

/** Waiters share the publication signal and keep the last fully delivered cursor on failure. */
export const waitForMessages = <E, R>(options: {
	readonly first: typeof Envelope.Type;
	readonly deadline: number;
	readonly changed: (after: number) => Effect.Effect<number, E, R>;
	readonly query: (since: number) => Effect.Effect<typeof Envelope.Type, E, R>;
	readonly view: (page: typeof Envelope.Type) => Effect.Effect<typeof Envelope.Type, E, R>;
	readonly drained: Effect.Effect<void, never, R>;
}) =>
	Effect.gen(function* () {
		let last = options.first;
		const run = Effect.gen(function* () {
			while (true) {
				yield* options.changed(last.cursor);
				const next = yield* options.query(last.cursor);
				if (next.items.length > 0) return yield* options.view(next);
				last = next;
			}
		});
		return yield* run.pipe(
			Effect.raceFirst(options.drained.pipe(Effect.map(() => ({ ...last, items: [], drained: true })))),
			Effect.timeoutOrElse({
				duration: Math.max(0, options.deadline - (yield* Clock.currentTimeMillis)),
				orElse: () => Effect.succeed({ ...last, timed_out: true }),
			}),
			Effect.catchCause(() => Effect.succeed({ ...last, items: [], drained: true })),
		);
	});
