import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Queue, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { EventPage, EventRecord } from "@comms/protocol/events";
import { KernelError, type EventQuery } from "../../../src/kernel/boot-channel.ts";
import { makeMessageChanges } from "../../../src/ext/core/message-changes.ts";
import { waitForMessages } from "../../../src/ext/core/message-wait.ts";

const event = (seq: number): typeof EventRecord.Type => ({
	seq,
	at: 0,
	type: "message.created",
	level: "info",
	actor: "agent",
	instance: "instance",
	generation: 1,
	request_id: null,
	topic: "a",
	message_id: "m",
	payload: {},
});
const page = (cursor: number, items: typeof EventPage.Type.items = []): typeof EventPage.Type => ({
	cursor,
	items,
	timed_out: false,
	drained: false,
});
const harness = Effect.gen(function* () {
	const requests = yield* Queue.unbounded<EventQuery>();
	const pages = yield* Queue.unbounded<Effect.Effect<typeof EventPage.Type, KernelError>>();
	const alignments = yield* Queue.unbounded<number>();
	const events = {
		query: (input: EventQuery) => Queue.offer(requests, input).pipe(Effect.andThen(Queue.take(pages)), Effect.flatten),
		changed: (after: number) => Queue.offer(alignments, after).pipe(Effect.as(after + 1)),
	};
	const changes = yield* makeMessageChanges;
	return { requests, pages, alignments, events, changes };
});

it.effect("shares one follower across waiters and skips empty diagnostic pages without message re-queries", () =>
	Effect.gen(function* () {
		const h = yield* harness;
		const queries = yield* Ref.make(0);
		const drained = yield* Deferred.make<void>();
		const first = { ...page(4), items: [] };
		const waiters = yield* Effect.forEach([1, 2, 3], () =>
			Effect.gen(function* () {
				// Request scopes may close; the follower belongs to the enclosing core scope.
				yield* h.changes.register(h.events, 4).pipe(Effect.scoped);
				return yield* waitForMessages({
					first,
					deadline: 60_000,
					changed: h.changes.changed,
					query: () => Ref.update(queries, (count) => count + 1).pipe(Effect.as({ ...first, cursor: 30 })),
					view: Effect.succeed,
					drained: Deferred.await(drained),
				}).pipe(Effect.forkScoped);
			}),
		);
		expect(yield* Queue.take(h.requests)).toEqual({
			since: 4,
			limit: 200,
			wait: 60,
		});
		for (const cursor of [10, 20, 30]) {
			yield* Queue.offer(
				h.pages,
				Effect.succeed(
					page(cursor, [
						{ ...event(cursor - 1), type: "seq.reserved" },
						{ ...event(cursor), type: "http.request" },
					]),
				),
			);
			expect((yield* Queue.take(h.requests)).since).toBe(cursor);
		}
		yield* TestClock.adjust("1 second");
		expect(yield* Ref.get(queries)).toBe(0);
		yield* Deferred.succeed(drained, undefined);
		for (const waiter of waiters) expect(yield* Fiber.join(waiter)).toEqual({ ...first, drained: true });
	}),
);

it.effect(
	"retains an event between registration and the initial query, and uses item sequence rather than page cursor",
	() =>
		Effect.gen(function* () {
			const h = yield* harness;
			yield* h.changes.register(h.events, 4);
			yield* Queue.take(h.requests);
			yield* Queue.offer(h.pages, Effect.succeed(page(100, [event(7)])));
			expect(yield* Queue.take(h.alignments)).toBe(6);
			expect((yield* Queue.take(h.requests)).since).toBe(100);
			// The original SQL snapshot was at 4; registration must retain the intervening event.
			expect(yield* h.changes.changed(4)).toBe(7);
			const queries = yield* Ref.make(0);
			const waiter = yield* waitForMessages({
				first: { ...page(7), items: [] },
				deadline: 1000,
				changed: h.changes.changed,
				query: () => Ref.update(queries, (count) => count + 1).pipe(Effect.as({ ...page(100), items: [] })),
				view: Effect.succeed,
				drained: Effect.never,
			}).pipe(Effect.forkScoped);
			yield* TestClock.adjust("1 second");
			expect((yield* Fiber.join(waiter)).cursor).toBe(7);
			expect(yield* Ref.get(queries)).toBe(0);
		}),
);

it.effect("waits for the cached publication fence before notifying and consumes successive filtered pages", () =>
	Effect.gen(function* () {
		const h = yield* harness;
		const aligned = yield* Deferred.make<number>();
		const notified = yield* Ref.make(false);
		yield* h.changes.register(
			{
				...h.events,
				changed: (after) => Queue.offer(h.alignments, after).pipe(Effect.andThen(Deferred.await(aligned))),
			},
			4,
		);
		yield* Queue.take(h.requests);
		const waiter = yield* h.changes.changed(4).pipe(
			Effect.tap(() => Ref.set(notified, true)),
			Effect.forkScoped,
		);
		yield* Queue.offer(h.pages, Effect.succeed(page(7, [event(5), event(7)])));
		expect(yield* Queue.take(h.alignments)).toBe(6);
		yield* TestClock.adjust("1 second");
		expect(yield* Ref.get(notified)).toBe(false);
		yield* Deferred.succeed(aligned, 7);
		expect(yield* Fiber.join(waiter)).toBe(7);
		expect((yield* Queue.take(h.requests)).since).toBe(7);
		yield* Queue.offer(h.pages, Effect.succeed(page(12, [event(11)])));
		yield* Queue.take(h.requests);
		expect(yield* h.changes.changed(7)).toBe(11);
	}),
);

for (const failure of ["transport", "drained"] as const)
	it.effect(`drains waiting responses on ${failure} failure and retries without advancing the failed cursor`, () =>
		Effect.gen(function* () {
			const h = yield* harness;
			yield* h.changes.register(h.events, 4);
			yield* Queue.take(h.requests);
			const first = { ...page(4), items: [] };
			const waiter = yield* waitForMessages({
				first,
				deadline: 60_000,
				changed: h.changes.changed,
				query: () => Effect.die("must not requery on follower failure"),
				view: Effect.succeed,
				drained: Effect.never,
			}).pipe(Effect.forkScoped);
			yield* Queue.offer(
				h.pages,
				failure === "transport"
					? Effect.fail(new KernelError({ code: "boot_unavailable" }))
					: Effect.succeed({ ...page(99, [event(98)]), drained: true }),
			);
			expect(yield* Fiber.join(waiter)).toEqual({ ...first, drained: true });
			yield* TestClock.adjust("1 second");
			expect((yield* Queue.take(h.requests)).since).toBe(4);
			yield* Queue.offer(h.pages, Effect.succeed(page(5, [event(5)])));
			yield* Queue.take(h.requests);
			expect(yield* h.changes.changed(4)).toBe(5);
		}),
	);

for (const type of ["sql.write", "extension.custom_mutation"])
	it.effect(`wakes conservatively for ${type}`, () =>
		Effect.gen(function* () {
			const h = yield* harness;
			yield* h.changes.register(h.events, 4);
			yield* Queue.take(h.requests);
			yield* Queue.offer(
				h.pages,
				Effect.succeed(
					page(9, [
						{ ...event(8), type },
						{ ...event(9), type: "http.request" },
					]),
				),
			);
			yield* Queue.take(h.requests);
			expect(yield* h.changes.changed(4)).toBe(8);
		}),
	);
