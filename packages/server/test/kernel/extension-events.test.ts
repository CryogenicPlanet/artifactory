import { Deferred, Effect, Fiber, Ref } from "effect";
import { expect, it } from "vitest";
import { KernelError, type EventRecord } from "../../src/kernel/boot-channel.ts";
import { runEvents } from "../../src/kernel/extension-events.ts";

const event = (seq: number): typeof EventRecord.Type => ({
	seq,
	at: 1,
	type: "message.created",
	level: "info",
	actor: "codex",
	instance: "own-instance",
	generation: 1,
	request_id: null,
	topic: "project",
	message_id: "m_one",
	payload: { body: "published" },
});
const page = (items: ReadonlyArray<typeof EventRecord.Type>, cursor: number) => ({
	items,
	cursor,
	timed_out: false,
	drained: false,
});

it("retries a failed read without advancing, keeps own-instance messages, and advances only after callbacks", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const cursor = yield* Ref.make(4);
			const attempts = yield* Ref.make(0);
			const seen = yield* Ref.make<ReadonlyArray<number>>([]);
			const read = () =>
				Effect.gen(function* () {
					const attempt = yield* Ref.getAndUpdate(attempts, (n) => n + 1);
					if (attempt === 0) return yield* new KernelError({ code: "boot_unavailable" });
					if (attempt === 1) return page([event(5), event(6)], 6);
					return page([event(6)], 6); // Invalid replay proves the prior page was acknowledged through 6.
				});
			const result = yield* runEvents(
				read,
				cursor,
				[{ type: "message.*", handle: (e) => Ref.update(seen, (items) => [...items, e.seq]) }],
				Effect.void,
			).pipe(Effect.result);
			expect(result._tag).toBe("Failure");
			expect(yield* Ref.get(cursor)).toBe(6);
			expect(yield* Ref.get(seen)).toEqual([5, 6]);
		}),
	);
});

it("advances exhausted filtered pages through unmatched events after completing callbacks", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const cursor = yield* Ref.make(4);
			const seen = yield* Ref.make<ReadonlyArray<number>>([]);
			const queried = yield* Ref.make<ReadonlyArray<number>>([]);
			yield* runEvents(
				({ since }) =>
					Ref.update(queried, (items) => [...items, since]).pipe(
						Effect.as(since === 4 ? page([], 7) : since === 7 ? page([event(8)], 10) : page([], 9)),
					),
				cursor,
				[{ type: "message.created", handle: (e) => Ref.update(seen, (items) => [...items, e.seq]) }],
				Effect.void,
			).pipe(Effect.result);
			expect(yield* Ref.get(cursor)).toBe(10);
			expect(yield* Ref.get(queried)).toEqual([4, 7, 10]);
			expect(yield* Ref.get(seen)).toEqual([8]);
		}),
	);
});

it("rejects a malformed page before invoking callbacks and preserves the cursor on callback failure", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const cursor = yield* Ref.make(4);
			const seen = yield* Ref.make(0);
			const handle = () => Ref.update(seen, (n) => n + 1);
			yield* runEvents(
				() => Effect.succeed(page([event(5), event(4)], 5)),
				cursor,
				[{ type: "*", handle }],
				Effect.void,
			).pipe(Effect.result);
			expect(yield* Ref.get(seen)).toBe(0);
			yield* runEvents(
				() => Effect.succeed(page([event(5)], 9)),
				cursor,
				[
					{ type: "*", handle },
					{ type: "message.created", handle: () => Effect.fail("callback failed") },
				],
				Effect.void,
			).pipe(Effect.result);
			expect(yield* Ref.get(cursor)).toBe(4);
			expect(yield* Ref.get(seen)).toBe(1);
		}),
	);
});

it("rechecks live admission before each callback and never advances past suppressed work", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const cursor = yield* Ref.make(4);
			const count = yield* Ref.make(0);
			const handle = () => Ref.update(count, (n) => n + 1);
			const admit = Ref.get(count).pipe(
				Effect.flatMap((n) => (n === 0 ? Effect.void : Effect.fail(new KernelError({ code: "generation_not_live" })))),
			);
			yield* runEvents(
				() => Effect.succeed(page([event(5), event(6)], 6)),
				cursor,
				[{ type: "*", handle }],
				admit,
			).pipe(Effect.result);
			expect(yield* Ref.get(cursor)).toBe(5);
			expect(yield* Ref.get(count)).toBe(1);
		}),
	);
});

it("replays unfinished work after interruption while preserving the same cursor", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const cursor = yield* Ref.make(4);
			const entered = yield* Deferred.make<void>();
			const seen = yield* Ref.make<ReadonlyArray<number>>([]);
			const read = () => Effect.succeed(page([event(5)], 5));
			const pending = yield* runEvents(
				read,
				cursor,
				[
					{
						type: "message.created",
						handle: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
					},
				],
				Effect.void,
			).pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(pending);
			expect(yield* Ref.get(cursor)).toBe(4);
			// A second delivery of 5 is then rejected by page validation, ending the resumed loop.
			yield* runEvents(
				read,
				cursor,
				[{ type: "message.created", handle: (e) => Ref.update(seen, (items) => [...items, e.seq]) }],
				Effect.void,
			).pipe(Effect.result);
			expect(yield* Ref.get(cursor)).toBe(5);
			expect(yield* Ref.get(seen)).toEqual([5]);
		}),
	);
});
