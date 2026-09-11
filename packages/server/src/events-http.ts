import { EventPage } from "@comms/protocol/events";
import type { CoreApi } from "@comms/protocol";
import { Clock, Effect, Layer, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { refusal } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import type { Api as ExtensionApi } from "./kernel/extension-api.ts";
import { layer } from "./request-schema.ts";

export const eventsHandlers = (api: typeof CoreApi, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "events", (handlers) =>
		handlers.handle("query", ({ query, request }) =>
			refusal(
				Effect.gen(function* () {
					const ctx = yield* extension.context("read");
					const params = new URL(request.url, "http://localhost").searchParams;
					if (params.toString().length > 4096 || [...params.keys()].some((key) => params.getAll(key).length !== 1))
						return yield* new KernelError({ code: "query_invalid" });
					const wait = query.wait ?? 0;
					const input = {
						limit: query.limit ?? 100,
						...(query.since === undefined ? {} : { since: query.since }),
						...(query.topic === undefined ? {} : { topic: query.topic }),
						...(query.types === undefined ? {} : { types: query.types.split(",") }),
						...(query.agent === undefined ? {} : { agent: query.agent }),
						...(query.instance === undefined ? {} : { instance: query.instance }),
						...(query.level === undefined ? {} : { level: query.level }),
						...(ctx.kind === "agent" ? { requestActor: ctx.agent } : {}),
						...(wait > 0 ? { excludeMessageInstance: ctx.instance } : {}),
					};
					let current = yield* ctx.events.query(input);
					const headers = { "cache-control": "no-store", "x-accel-buffering": "no" };
					if (current.items.length > 0 || wait === 0) return HttpServerResponse.jsonUnsafe(current, { headers });
					const deadline = (yield* Clock.currentTimeMillis) + wait * 1000;
					const poll = Effect.gen(function* () {
						while (true) {
							yield* ctx.events.changed(current.cursor);
							current = yield* ctx.events.query({ ...input, since: current.cursor });
							if (current.items.length > 0) return current;
						}
					});
					const drained = () => ({ ...current, items: [], timed_out: false, drained: true });
					const result = Effect.gen(function* () {
						return yield* poll.pipe(
							Effect.raceFirst(ctx.drained.pipe(Effect.map(drained))),
							Effect.timeoutOrElse({
								duration: Math.max(0, deadline - (yield* Clock.currentTimeMillis)),
								orElse: () => Effect.succeed({ ...current, timed_out: true }),
							}),
						);
					}).pipe(Effect.catchCause(() => Effect.succeed(drained())));
					const encoder = new TextEncoder();
					return HttpServerResponse.stream(
						Stream.merge(
							Stream.fromEffect(result.pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(EventPage))))),
							Stream.tick("10 seconds").pipe(Stream.map(() => "\n")),
							{ haltStrategy: "left" },
						).pipe(Stream.map((value) => encoder.encode(value))),
						{ contentType: "application/json", headers },
					);
				}),
			),
		),
	).pipe(Layer.provide(layer(131072)));
