import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { waitForMessages } from "../src/kernel/message-wait.ts";

const first = { items: [], cursor: 4, timed_out: false, drained: false };
it.effect("does no idle reads and finishes immediately on drain", () =>
	Effect.gen(function* () {
		const drained = yield* Deferred.make<void>();
		const queries = yield* Ref.make(0);
		const fiber = yield* waitForMessages({
			first,
			deadline: 60_000,
			changed: () => Effect.never,
			query: () => Ref.update(queries, (n) => n + 1).pipe(Effect.as(first)),
			view: Effect.succeed,
			drained: Deferred.await(drained),
		}).pipe(Effect.forkScoped);
		yield* TestClock.adjust("30 seconds");
		expect(yield* Ref.get(queries)).toBe(0);
		yield* Deferred.succeed(drained, undefined);
		expect(yield* Fiber.join(fiber)).toEqual({ ...first, drained: true });
	}),
);
it.effect("preserves the last considered cursor when delivery marking fails", () =>
	Effect.gen(function* () {
		const page = {
			...first,
			cursor: 7,
			items: [
				{
					id: "message",
					seq: 7,
					topic: "a",
					agent: "pi",
					instance: "pi",
					body: "hi",
					tags: [],
					meta: {},
					created_at: 0,
					edited_at: null,
					deleted_at: null,
				},
			],
		};
		const result = yield* waitForMessages({
			first,
			deadline: 60_000,
			changed: () => Effect.succeed(7),
			query: () => Effect.succeed(page),
			view: () => Effect.fail("mark_failed"),
			drained: Effect.never,
		});
		expect(result).toEqual({ ...first, drained: true });
	}),
);
it.effect("advances past empty filtered publications without replaying them at timeout", () =>
	Effect.gen(function* () {
		const queries = yield* Ref.make<readonly number[]>([]);
		const fiber = yield* waitForMessages({
			first,
			deadline: 1000,
			changed: (after) => (after < 9 ? Effect.succeed(9) : Effect.never),
			query: (since) => Ref.update(queries, (values) => [...values, since]).pipe(Effect.as({ ...first, cursor: 9 })),
			view: Effect.succeed,
			drained: Effect.never,
		}).pipe(Effect.forkScoped);
		yield* TestClock.adjust("1 second");
		expect(yield* Fiber.join(fiber)).toEqual({ ...first, cursor: 9, timed_out: true });
		expect(yield* Ref.get(queries)).toEqual([4]);
	}),
);
