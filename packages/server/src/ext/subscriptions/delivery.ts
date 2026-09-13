import { Cause, DateTime, Effect, type Semaphore, Stream } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Api, BackgroundContext } from "../../kernel/extension-api.ts";
import type { makeStore } from "./store.ts";
import { type Stored, SubscriptionError } from "./contract.ts";

type Event = Effect.Success<ReturnType<BackgroundContext["events"]["query"]>>["items"][number];
export const deliver = (effects: Pick<Api["effects"], "fetch">, row: Stored, event: Event) =>
	Effect.gen(function* () {
		const request = HttpClientRequest.post(row.input.deliver.url).pipe(
			HttpClientRequest.bodyJsonUnsafe({ subscription_id: row.id, event }),
			HttpClientRequest.setHeader("x-chirp-delivery-id", `${row.id}:${event.seq}`),
		);
		return yield* effects.fetch(request, (response) =>
			Effect.gen(function* () {
				let bytes = 0;
				if (response.status !== 204 && response.status !== 205)
					yield* response.stream.pipe(
						Stream.runForEach((chunk) => {
							bytes += chunk.byteLength;
							return bytes > 65536
								? Effect.fail(new SubscriptionError({ code: "webhook_response_too_large" }))
								: Effect.void;
						}),
					);
				return response.status;
			}),
		);
	}).pipe(
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
		Effect.timeout("2 seconds"),
	);

/** The start scope cancels this worker and its network requests before replacement jobs begin. */
export const runDelivery = (
	ctx: Pick<BackgroundContext, "read" | "events">,
	store: Pick<ReturnType<typeof makeStore>, "visible" | "checkpoint">,
	gate: Semaphore.Semaphore,
	effects: Pick<Api["effects"], "fetch">,
) =>
	Effect.gen(function* () {
		while (true) {
			const cycle = yield* Effect.gen(function* () {
				const fence = yield* ctx.read((value) => Effect.succeed(value));
				const subscriptions = yield* store.visible;
				let backlog = false;
				let retryAt: number | undefined;
				for (const previous of subscriptions) {
					if (previous.deleted_seq !== null) continue;
					if (previous.next_attempt > (yield* DateTime.nowAsDate).getTime()) {
						retryAt = Math.min(retryAt ?? Infinity, previous.next_attempt);
						continue;
					}
					const attempt = yield* Effect.gen(function* () {
						const page = yield* ctx.events.query({
							since: previous.cursor,
							limit: 64,
							...(previous.input.filter.topic === undefined ? {} : { topic: previous.input.filter.topic }),
							...(previous.input.filter.types === undefined ? {} : { types: previous.input.filter.types }),
						});
						let stopped = false;
						for (const event of page.items) {
							// Release between deliveries so deletion waits behind only one bounded attempt.
							const accepted = yield* gate.withPermit(
								Effect.gen(function* () {
									// This fresh read checks the durable writer epoch. The gate also excludes deletion
									// until dispatch finishes; effects.fetch separately admits only live work.
									const row = (yield* store.visible).find((item) => item.id === previous.id);
									if (!row || row.deleted_seq !== null) return false;
									if (!Number.isSafeInteger(event.seq) || event.seq <= row.cursor || event.seq > page.cursor)
										return yield* new SubscriptionError({ code: "event_cursor_invalid" });
									const visible =
										!(row.human === 0 && event.type === "http.request" && event.actor !== row.agent) &&
										(row.input.filter.agent === undefined || event.actor === row.input.filter.agent);
									if (visible) {
										const outcome = yield* deliver(effects, row, event).pipe(Effect.result);
										const response = outcome._tag === "Success" ? outcome.success : undefined;
										if (response?.status === "suppressed") return false;
										const delivered = response !== undefined && response.value >= 200 && response.value < 300;
										if (!delivered) {
											yield* store.checkpoint(
												row,
												row.cursor,
												response === undefined ? "transport_failed" : `http_${response.value}`,
											);
											return false;
										}
									}
									yield* store.checkpoint(row, event.seq, null);
									return true;
								}),
							);
							if (!accepted) {
								stopped = true;
								break;
							}
						}
						return !stopped && page.items.length === 64;
					}).pipe(Effect.exit);
					if (attempt._tag === "Failure") {
						if (Cause.hasInterruptsOnly(attempt.cause)) return yield* Effect.interrupt;
						retryAt = Math.min(retryAt ?? Infinity, (yield* DateTime.nowAsDate).getTime() + 500);
					} else backlog ||= attempt.value;
				}
				// Read persisted deadlines after attempts; retries are independent of event arrivals.
				const now = (yield* DateTime.nowAsDate).getTime();
				for (const row of yield* store.visible)
					if (row.deleted_seq === null && row.next_attempt > now)
						retryAt = Math.min(retryAt ?? Infinity, row.next_attempt);
				if (backlog) return;
				const changed = ctx.events.changed(fence);
				if (retryAt === undefined) yield* changed;
				else
					yield* Effect.raceFirst(changed, Effect.sleep(Math.max(0, retryAt - (yield* DateTime.nowAsDate).getTime())));
			}).pipe(Effect.exit);
			if (cycle._tag === "Failure") {
				if (Cause.hasInterruptsOnly(cycle.cause)) return yield* Effect.interrupt;
				// Store or checkpoint failures are retried with bounded backoff, without advancing delivery.
				yield* Effect.sleep("500 millis");
			}
		}
	});
