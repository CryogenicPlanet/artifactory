import { DateTime, Effect, Ref, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { identity, failure, integer } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { Lifecycle } from "./kernel/lifecycle.ts";
import { Envelope, Messages } from "./kernel/messages.ts";
import { Topics, TopicResult } from "./kernel/topics.ts";
import { ReadInput, ReadResult } from "./kernel/read-marks.ts";

const topicQuery = Object.freeze({
	depth: Schema.optionalKey(Schema.String),
	archived: Schema.optionalKey(Schema.String),
});
export const topicsGroup = HttpApiGroup.make("topics").add(
	HttpApiEndpoint.get("detail", "/api/topics/*", { query: topicQuery, success: TopicResult }).annotate(
		OpenApi.Description,
		"GET /api/topics is the root alias. Read a topic and all subtopics within depth, latest100 direct messages, published activity and instance unread. Archived children require archived=1.",
	),
	HttpApiEndpoint.get("inbox", "/api/inbox", {
		query: {
			since: Schema.optionalKey(Schema.String),
			limit: Schema.optionalKey(Schema.String),
			wait: Schema.optionalKey(Schema.String),
			mode: Schema.optionalKey(Schema.String),
		},
		success: Envelope,
	}).annotate(
		OpenApi.Description,
		"Read messages from other instances. mode=agent (default) includes the agent home subtree and exact agent or instance mentions; mode=instance includes only this label subtree and exact instance mentions. Both include @here. A label outside the path grammar receives only @here in instance mode. Modes share one per-instance ~inbox cursor; use explicit since for separate caller-held cursors. Omitted since uses that mark for immediate reads and now for waits. Requires read.",
	),
	HttpApiEndpoint.post("read", "/api/read", { payload: ReadInput, success: ReadResult }).annotate(
		OpenApi.Description,
		"Advance exactly one instance read mark monotonically; * marks root and ~inbox marks inbox. Returns effective ancestor cursor; success follows durable read.marked publication. Requires read. Idempotency-Key preserves first result.",
	),
);
const topic = () =>
	failure(
		Effect.gen(function* () {
			const who = yield* identity("read");
			const request = yield* HttpServerRequest.HttpServerRequest;
			const url = new URL(request.url, "http://localhost");
			if ([...url.searchParams.keys()].some((key) => key !== "depth" && key !== "archived"))
				return yield* new KernelError({ code: "query_invalid" });
			const depth = integer(url.searchParams.get("depth"), 1, 200);
			const archived = url.searchParams.get("archived");
			if (depth === null || depth < 1 || (archived !== null && archived !== "0" && archived !== "1"))
				return yield* new KernelError({ code: "query_invalid" });
			const path =
				url.pathname === "/api/topics"
					? ""
					: yield* Effect.try({
							try: () => decodeURIComponent(url.pathname.slice("/api/topics/".length)),
							catch: () => new KernelError({ code: "query_invalid" }),
						});
			return HttpServerResponse.jsonUnsafe(yield* (yield* Topics).detail(who, path, depth, archived === "1"));
		}),
	);
// Deferred construction avoids coupling group declaration order to the assembled API.
export const topicHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "topics", (handlers) =>
		handlers

			.handleRaw("detail", () => topic())
			.handleRaw("read", () =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("read");
						const request = yield* HttpServerRequest.HttpServerRequest;
						let bytes = 0;
						const chunks = yield* request.stream.pipe(
							Stream.tap((chunk) =>
								Effect.gen(function* () {
									bytes += chunk.byteLength;
									if (bytes > 4096) return yield* new KernelError({ code: "input_invalid" });
								}),
							),
							Stream.runCollect,
							Effect.timeout("5 seconds"),
						);
						const input = yield* Schema.decodeEffect(Schema.fromJsonString(ReadInput))(
							Buffer.concat(chunks).toString("utf8"),
						).pipe(Effect.mapError(() => new KernelError({ code: "input_invalid" })));
						return HttpServerResponse.jsonUnsafe(
							yield* (yield* Messages).mark(who, input, request.headers["idempotency-key"]),
						);
					}),
				),
			)
			.handleRaw("inbox", () => inboxResponse),
	);

export const inboxResponse = failure(
	Effect.gen(function* () {
		const who = yield* identity("read");
		const request = yield* HttpServerRequest.HttpServerRequest;
		const params = new URL(request.url, "http://localhost").searchParams;
		if ([...params.keys()].some((key) => !["since", "limit", "wait", "mode"].includes(key)))
			return yield* new KernelError({ code: "query_invalid" });
		const since = integer(params.get("since"), 0, Number.MAX_SAFE_INTEGER),
			limit = integer(params.get("limit"), 100, 200),
			wait = integer(params.get("wait"), 0, 60);
		if (since === null || limit === null || limit === 0 || wait === null)
			return yield* new KernelError({ code: "query_invalid" });
		const mode = params.get("mode") ?? "agent";
		if (mode !== "agent" && mode !== "instance") return yield* new KernelError({ code: "query_invalid" });
		const topics = yield* Topics;
		const messages = yield* Messages;
		// Capture before scanning: a later publication must trigger another scan.
		let observedFence = wait > 0 ? (yield* messages.fence).published_through : 0;
		const cursor = params.has("since") ? since : wait > 0 ? observedFence : yield* topics.cursor(who);
		const first = yield* topics.inbox(who, cursor, limit, mode);
		if (first.items.length || wait === 0) return HttpServerResponse.jsonUnsafe(first);
		const lifecycle = yield* Lifecycle;
		const deadline = (yield* DateTime.nowAsDate).getTime() + wait * 1000;
		const result = Effect.gen(function* () {
			while ((yield* DateTime.nowAsDate).getTime() < deadline) {
				if ((yield* Ref.get(lifecycle.state)) === "draining") return { ...first, drained: true };
				yield* Effect.sleep("100 millis");
				const published = (yield* messages.fence).published_through;
				if (published === observedFence) continue;
				observedFence = published;
				// Retain since: edits can turn previously scanned messages into mentions.
				const next = yield* topics.inbox(who, cursor, limit, mode);
				if (next.items.length) return next;
			}
			return { ...first, timed_out: true };
		});
		const encoder = new TextEncoder();
		return HttpServerResponse.stream(
			Stream.merge(
				Stream.fromEffect(result.pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Envelope))))),
				Stream.tick("10 seconds").pipe(Stream.map(() => "\n")),
				{ haltStrategy: "left" },
			).pipe(Stream.map((value) => encoder.encode(value))),
			{ contentType: "application/json" },
		);
	}),
);
