import { Deferred, Effect, Fiber, Ref, Semaphore } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { runDelivery } from "../../../src/ext/subscriptions/delivery.ts";
import type { Stored } from "../../../src/ext/subscriptions/contract.ts";

it.each([false, true])(
	"waits without polling, then checkpoints only sent deliveries (suppressed: %s)",
	async (suppressed) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const row = yield* Ref.make<Stored>({
					id: "s",
					instance: "i",
					agent: "a",
					human: 1,
					input: { filter: {}, deliver: { kind: "webhook", url: "https://example.test" } },
					idempotency_key: null,
					created_at: 0,
					start_seq: 0,
					created_seq: 0,
					deleted_seq: null,
					cursor: 0,
					attempts: 1,
					next_attempt: 1,
					last_error: "http_503",
				});
				const fence = yield* Ref.make(0);
				const wake = yield* Deferred.make<number>();
				const waiting = yield* Deferred.make<void>();
				const finished = yield* Deferred.make<void>();
				const queries = yield* Ref.make(0);
				const delivered = yield* Ref.make<ReadonlyArray<number>>([]);
				const client = HttpClient.make((request) =>
					Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
				);
				const gate = yield* Semaphore.make(1);
				const ctx: Parameters<typeof runDelivery>[0] = {
					read: (effect) => Ref.get(fence).pipe(Effect.flatMap(effect)),
					events: {
						query: ({ since = 0 }) =>
							Effect.gen(function* () {
								yield* Ref.update(queries, (n) => n + 1);
								const end = yield* Ref.get(fence);
								return {
									items: Array.from({ length: end - since }, (_, n) => ({
										seq: since + n + 1,
										at: 1,
										type: "message.created",
										level: "info" as const,
										actor: "a",
										instance: "i",
										generation: 1,
										request_id: null,
										topic: "project",
										message_id: null,
										payload: {},
									})),
									cursor: end,
									timed_out: false,
									drained: false,
								};
							}),
						changed: (after) =>
							Effect.gen(function* () {
								if (after === 0) {
									yield* Deferred.succeed(waiting, undefined);
									return yield* Deferred.await(wake);
								}
								yield* Deferred.succeed(finished, undefined);
								return yield* Effect.never;
							}),
					},
				};
				const worker = yield* runDelivery(
					ctx,
					{
						visible: Ref.get(row).pipe(Effect.map((item) => [item])),
						checkpoint: (_previous, cursor) =>
							Ref.update(row, (item) => ({ ...item, cursor })).pipe(
								Effect.andThen(Ref.update(delivered, (items) => [...items, cursor])),
							),
					},
					gate,
					{
						fetch: (request, consume) =>
							suppressed
								? Effect.succeed({ status: "suppressed" } as const)
								: client.execute(request).pipe(
										Effect.flatMap(consume),
										Effect.scoped,
										Effect.map((value) => ({ status: "sent", value }) as const),
									),
					},
				).pipe(Effect.forkChild);
				yield* Deferred.await(waiting);
				yield* Effect.sleep("250 millis");
				expect(yield* Ref.get(queries)).toBe(1);
				yield* Ref.set(fence, 3);
				yield* Deferred.succeed(wake, 3);
				yield* Deferred.await(finished);
				expect(yield* Ref.get(delivered)).toEqual(suppressed ? [] : [1, 2, 3]);
				expect((yield* Ref.get(row)).cursor).toBe(suppressed ? 0 : 3);
				expect(yield* Ref.get(queries)).toBe(2);
				yield* Fiber.interrupt(worker);
			}).pipe(Effect.timeout("3 seconds")),
		);
	},
);
