import { DateTime, Effect, Ref, type Semaphore, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { BootChannel, KernelError, type EventRecord } from "../../kernel/boot-channel.ts";
import { Lifecycle } from "../../kernel/lifecycle.ts";
import type { makeStore } from "./store.ts";
import type { Stored } from "./contract.ts";

export const deliver = (client: HttpClient.HttpClient, row: Stored, event: typeof EventRecord.Type) =>
	Effect.gen(function* () {
		const request = HttpClientRequest.post(row.input.deliver.url).pipe(
			HttpClientRequest.bodyJsonUnsafe({ subscription_id: row.id, event }),
			HttpClientRequest.setHeader("x-comms-delivery-id", `${row.id}:${event.seq}`),
		);
		const response = yield* client.execute(request);
		let bytes = 0;
		yield* response.stream.pipe(
			Stream.runForEach((chunk) => {
				bytes += chunk.byteLength;
				return bytes > 65536 ? Effect.fail(new KernelError({ code: "webhook_response_too_large" })) : Effect.void;
			}),
		);
		return response.status;
	}).pipe(
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
		Effect.timeout("2 seconds"),
	);

export const runDelivery = (store: Effect.Success<typeof makeStore>, gate: Semaphore.Semaphore) =>
	Effect.gen(function* () {
		const boot = yield* BootChannel,
			client = yield* HttpClient.HttpClient,
			lifecycle = yield* Lifecycle;
		while (true) {
			const subscriptions = yield* store.visible.pipe(Effect.result);

			if (subscriptions._tag === "Success")
				for (const previous of subscriptions.success) {
					yield* gate
						.withPermit(
							Effect.gen(function* () {
								const row = (yield* store.visible).find((item) => item.id === previous.id);
								if (!row || row.deleted_seq !== null || row.next_attempt > (yield* DateTime.nowAsDate).getTime())
									return;
								if ((yield* Ref.get(lifecycle.state)) !== "live") return yield* Effect.interrupt;
								const page = yield* boot.events({
									since: row.cursor,
									limit: 1,
									...(row.input.filter.topic === undefined ? {} : { topic: row.input.filter.topic }),
									...(row.input.filter.types === undefined ? {} : { types: row.input.filter.types }),
								});
								const event = page.items[0];

								if (!event) return;
								if (!Number.isSafeInteger(event.seq) || event.seq <= row.cursor || event.seq !== page.cursor)
									return yield* new KernelError({ code: "event_cursor_invalid" });
								// The private channel is privileged; preserve the ordinary agent event feed's audit boundary.
								if (
									(row.human === 0 && event.type === "http.request" && event.actor !== row.agent) ||
									(row.input.filter.agent !== undefined && event.actor !== row.input.filter.agent)
								) {
									yield* store.checkpoint(row, event.seq, null);
									return;
								}
								if ((yield* Ref.get(lifecycle.state)) !== "live") return yield* Effect.interrupt;
								yield* store.admit;
								const outcome = yield* deliver(client, row, event).pipe(Effect.result);
								const accepted = outcome._tag === "Success" && outcome.success >= 200 && outcome.success < 300;
								const error = accepted
									? null
									: outcome._tag === "Success"
										? `http_${outcome.success}`
										: "transport_failed";
								yield* store.checkpoint(row, accepted ? event.seq : row.cursor, error);
							}),
						)
						.pipe(
							Effect.catchCause((cause) =>
								cause.reasons.every((reason) => reason._tag === "Interrupt") ? Effect.interrupt : Effect.void,
							),
						);
				}
			yield* Effect.sleep("100 millis");
		}
	});
