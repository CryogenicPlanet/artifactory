import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Fiber, Layer, Ref, Schema, Semaphore, Stream } from "effect";
import { TestClock } from "effect/testing";
import { HttpServerRequest } from "effect/unstable/http";
import { inboxResponse } from "../src/topics-http.ts";
import { Envelope, Messages, type Message } from "../src/kernel/messages.ts";
import { Topics } from "../src/kernel/topics.ts";
import { Lifecycle, type State } from "../src/kernel/lifecycle.ts";

const request = (query: string) =>
	HttpServerRequest.fromWeb(
		new Request(`http://localhost/api/inbox?${query}`, {
			headers: {
				"x-comms-auth-kind": "agent",
				"x-comms-agent": "codex",
				"x-comms-instance": "one",
				"x-comms-request-id": "test",
				"x-comms-scopes": "read",
				"x-comms-label": "job",
			},
		}),
	);
const consume = Effect.gen(function* () {
	const response = yield* inboxResponse;
	expect(response.status).toBe(200);
	if (response.body._tag !== "Stream") return yield* Effect.die("Expected a waiting response");
	const chunks = yield* Stream.runCollect(response.body.stream.pipe(Stream.orDie));
	return yield* Schema.decodeEffect(Schema.fromJsonString(Envelope))(Buffer.concat(chunks).toString("utf8"));
});

it.effect("scans unchanged history once, rescans original since after publication, and retains instance and mode", () =>
	Effect.gen(function* () {
		const fence = yield* Ref.make(10);
		const calls = yield* Ref.make<ReadonlyArray<{ since: number; instance: string; mode: string | undefined }>>([]);
		const eligible = yield* Ref.make<ReadonlyArray<typeof Message.Type>>([]);
		const state = yield* Ref.make<State>("live");
		const layer = Layer.mergeAll(
			Layer.mock(Messages, { fence: Ref.get(fence).pipe(Effect.map((published_through) => ({ published_through }))) }),
			Layer.mock(Topics, {
				inbox: (who, since, _limit, mode) =>
					Effect.gen(function* () {
						yield* Ref.update(calls, (values) => [...values, { since, instance: who.instance, mode }]);
						const items = yield* Ref.get(eligible);
						return { items: [...items], cursor: items.at(-1)?.seq ?? since, timed_out: false, drained: false };
					}),
			}),
			Layer.mock(Lifecycle, {
				initial: "starting",
				state,
				mutations: yield* Ref.make(0),
				healthy: yield* Ref.make(true),
				gate: yield* Semaphore.make(1),
			}),
		);
		const fiber = yield* consume.pipe(
			Effect.provide(layer),
			Effect.provideService(HttpServerRequest.HttpServerRequest, request("since=0&wait=60&mode=instance")),
			Effect.forkScoped,
		);
		yield* TestClock.adjust("20 seconds");
		expect(yield* Ref.get(calls)).toEqual([{ since: 0, instance: "one", mode: "instance" }]);
		yield* Ref.set(fence, 11);
		yield* TestClock.adjust("1 second");
		expect(yield* Ref.get(calls)).toHaveLength(2);
		// A previously scanned message becomes an eligible mention; its creation sequence is unchanged.
		const edited = {
			id: "old",
			seq: 4,
			topic: "other",
			agent: "pi",
			instance: "two",
			body: "hello @codex/job",
			tags: [],
			meta: {},
			created_at: 0,
			edited_at: 12,
			deleted_at: null,
		};
		yield* Ref.set(eligible, [edited]);
		yield* TestClock.adjust("1 second");
		expect(yield* Ref.get(calls)).toHaveLength(2);
		yield* Ref.set(fence, 12);
		yield* TestClock.adjust("1 second");
		expect(yield* Fiber.join(fiber)).toEqual({ items: [edited], cursor: 4, timed_out: false, drained: false });
		expect(yield* Ref.get(calls)).toEqual(
			Array.from({ length: 3 }, () => ({ since: 0, instance: "one", mode: "instance" })),
		);
	}),
);

it.effect("keeps empty timeout and drain cursors while avoiding repeated scans", () =>
	Effect.gen(function* () {
		for (const drain of [false, true]) {
			const calls = yield* Ref.make(0);
			const state = yield* Ref.make<State>("live");
			const layer = Layer.mergeAll(
				Layer.mock(Messages, { fence: Effect.succeed({ published_through: 10 }) }),
				Layer.mock(Topics, {
					inbox: (_who, since) =>
						Ref.update(calls, (n) => n + 1).pipe(
							Effect.as({ items: [], cursor: since, timed_out: false, drained: false }),
						),
				}),
				Layer.mock(Lifecycle, {
					initial: "starting",
					state,
					mutations: yield* Ref.make(0),
					healthy: yield* Ref.make(true),
					gate: yield* Semaphore.make(1),
				}),
			);
			const fiber = yield* consume.pipe(
				Effect.provide(layer),
				Effect.provideService(HttpServerRequest.HttpServerRequest, request("since=3&wait=2")),
				Effect.forkScoped,
			);
			yield* TestClock.adjust("1 second");
			if (drain) yield* Ref.set(state, "draining");
			yield* TestClock.adjust("1 second");
			expect(yield* Fiber.join(fiber)).toEqual({ items: [], cursor: 3, timed_out: !drain, drained: drain });
			expect(yield* Ref.get(calls)).toBe(1);
		}
	}),
);
