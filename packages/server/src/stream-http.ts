import { QueryCursor } from "@comms/protocol/query-number";
import type { Api as ExtensionApi } from "./kernel/extension-api.ts";
import type { CoreApi as Api } from "@comms/protocol";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { refusal } from "./conversation-request.ts";
import { EventRecord } from "@comms/protocol/events";
import { KernelError } from "./kernel/boot-channel.ts";

import { layer } from "./request-schema.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(EventRecord));
export const streamHandlers = (api: typeof Api, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "stream", (handlers) =>
		handlers.handle("events", ({ query, request }) =>
			refusal(
				Effect.gen(function* () {
					const ctx = yield* extension.context("read");
					const lastEventId = request.headers["last-event-id"];
					const since =
						query.since ??
						(lastEventId === undefined
							? undefined
							: yield* Schema.decodeEffect(QueryCursor)(lastEventId).pipe(
									Effect.mapError(() => new KernelError({ code: "query_invalid" })),
								));
					const limit = query.limit ?? 100;
					// Boot remains the bounded event-filter parser and SQL visibility boundary.
					if (request.url.length > 4096) return yield* new KernelError({ code: "query_invalid" });
					const input = {
						...(since === undefined ? {} : { since }),
						limit,
						...(query.topic === undefined ? {} : { topic: query.topic }),
						...(query.types === undefined ? {} : { types: query.types.split(",") }),
						...(query.agent === undefined ? {} : { agent: query.agent }),
						...(query.instance === undefined ? {} : { instance: query.instance }),
						...(query.level === undefined ? {} : { level: query.level }),
						// A stream is one continuous wait, and a wait excludes the caller's own instance.
						// Without this an agent that moves from the long-poll to SSE for latency inherits a
						// feedback loop on its own writes.
						excludeMessageInstance: ctx.instance,
					};
					const first = yield* ctx.events.query(input);
					const pages = Stream.unfold(first, (page) =>
						Effect.gen(function* () {
							const next = yield* ctx.events.query({ ...input, since: page.cursor, wait: 60 });
							// A failed remote wait can return an unchanged empty page immediately.
							if (next.items.length === 0 && next.cursor === page.cursor) yield* Effect.sleep("1 second");
							return [next.items, next] as const;
						}),
					).pipe(Stream.flatMap((items) => Stream.fromIterable(items)));
					const events = Stream.concat(Stream.fromIterable(first.items), pages).pipe(
						Stream.map((event) => `id: ${event.seq}\ndata: ${encodeEvent(event)}\n\n`),
						Stream.catchCause(() => Stream.empty),
						Stream.interruptWhen(ctx.drained),
					);
					const encoder = new TextEncoder();
					return HttpServerResponse.stream(
						Stream.merge(events, Stream.tick("10 seconds").pipe(Stream.map(() => ": heartbeat\n\n")), {
							haltStrategy: "left",
						}).pipe(Stream.map((value) => encoder.encode(value))),
						{
							contentType: "text/event-stream",
							headers: { "cache-control": "no-store", "x-accel-buffering": "no" },
						},
					);
				}),
			),
		),
	).pipe(Layer.provide(layer(131072)));
