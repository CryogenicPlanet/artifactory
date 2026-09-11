import { failure } from "../../src/conversation-request.ts";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "../../src/kernel/extension-api.ts";

const endpoint = HttpApiEndpoint.get("drain", "/api/evlog", {
	query: Schema.Struct({
		since: Schema.optional(Schema.FiniteFromString),
		until: Schema.optional(Schema.FiniteFromString),
	}),
}).annotate(OpenApi.Description, "Download one bounded event-log page as NDJSON; resume from X-Evlog-Cursor.");
const definition = HttpApi.make("evlog").add(HttpApiGroup.make("evlog").add(endpoint));

/** Optional pull drain: curl this route into a local .ndjson file. No network sink is enabled. */
export default function evlogSink(api: Api) {
	api.mount(
		definition,
		HttpApiBuilder.group(definition, "evlog", (handlers) =>
			handlers.handleRaw("drain", ({ query }) =>
				Effect.gen(function* () {
					const ctx = yield* api.context("read");
					const since = query.since ?? 0;
					const actorFilter = ctx.kind === "human" ? {} : { requestActor: ctx.agent };
					const fence = (yield* ctx.events.query({ limit: 1, ...actorFilter })).cursor;
					const through = query.until ?? fence;
					if (!Number.isSafeInteger(through) || through < since || through > fence)
						return HttpServerResponse.empty({ status: 400 });
					if (!Number.isSafeInteger(since) || since < 0) return HttpServerResponse.empty({ status: 400 });
					const page = yield* ctx.events.query({
						since,
						limit: 100,
						...actorFilter,
					});
					const items = page.items.filter((event) => event.seq <= through);
					return HttpServerResponse.text(
						items
							.map((event) =>
								JSON.stringify({
									timestamp: new Date(event.at).toISOString(),
									level: event.level,
									message: event.type,
									seq: event.seq,
									requestId: event.request_id,
									agent: event.actor,
									generation: event.generation,
									topic: event.topic,
									data: event.payload,
								}),
							)
							.join("\n") + (items.length ? "\n" : ""),
						{
							contentType: "application/x-ndjson",
							headers: {
								"cache-control": "no-store",
								"x-evlog-cursor": String(Math.min(page.cursor, through)),
								"x-evlog-through": String(through),
							},
						},
					);
				}).pipe(failure),
			),
		),
	);
}
