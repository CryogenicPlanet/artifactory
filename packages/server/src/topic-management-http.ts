import { Effect, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { TopicDeletion } from "./kernel/topic-delete.ts";
import { TopicMove } from "./kernel/topic-move.ts";
import { Messages } from "./kernel/messages.ts";
import { TopicArchiveInput, TopicMetaInput, TopicMutation } from "./kernel/topic-operations.ts";

export const topicManagementGroup = HttpApiGroup.make("topicManagement").add(
	HttpApiEndpoint.post("move", "/api/topics/*", {
		payload: Schema.Struct({ to: Schema.String }),
		success: TopicMove,
	}).annotate(
		OpenApi.Description,
		"POST /api/topics/<path>/move with {to}. Requires write. Boot briefly pauses application traffic while coordinating the SQL prefix rewrite, page publication and topic.moved event. Destination subtrees must be absent. Explicit read cursor collisions retain MAX; reactions keep their message IDs and historical idempotency outcomes remain unchanged. Optional Idempotency-Key preserves the first outcome.",
	),
	HttpApiEndpoint.delete("delete", "/api/topics/*", { success: TopicDeletion }).annotate(
		OpenApi.Description,
		"Soft-delete a topic subtree. Requires write and either a human or the sole instance author of every message, including deleted messages. Empty and page-only topics require a human. Paths stay reserved; historical events remain. Success follows topic.deleted publication; optional Idempotency-Key preserves the first outcome.",
	),
	HttpApiEndpoint.put("meta", "/api/topics/*", { payload: TopicMetaInput, success: TopicMutation }).annotate(
		OpenApi.Description,
		"Replace a topic's meta with {meta:{...}}, creating missing ancestors. Requires write; archived topics are read-only. Exact meta.public:true opts that topic's pages public. Success follows durable topic.created/topic.meta publication; optional Idempotency-Key preserves the first outcome.",
	),
	HttpApiEndpoint.patch("archive", "/api/topics/*", { payload: TopicArchiveInput, success: TopicMutation }).annotate(
		OpenApi.Description,
		"Set {archived:true|false} on an existing topic. Requires write. Archived subtrees are read-only and hidden from root activity/unread, but remain directly readable. Unarchive the parent before its children. Success follows durable topic.archived publication; optional Idempotency-Key preserves the first outcome.",
	),
);
const mutate = (archive: boolean) =>
	failure(
		Effect.gen(function* () {
			const who = yield* identity("write");
			const request = yield* HttpServerRequest.HttpServerRequest;
			const url = new URL(request.url, "http://localhost");
			if (url.search) return yield* new KernelError({ code: "query_invalid" });
			const path = yield* Effect.try({
				try: () => decodeURIComponent(url.pathname.slice("/api/topics/".length)),
				catch: () => new KernelError({ code: "input_invalid" }),
			});
			let bytes = 0;
			const chunks = yield* request.stream.pipe(
				Stream.tap((chunk) =>
					Effect.gen(function* () {
						bytes += chunk.byteLength;
						if (bytes > 131072) return yield* new KernelError({ code: "input_invalid" });
					}),
				),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
			);
			const text = Buffer.concat(chunks).toString("utf8");
			const input = archive
				? yield* Schema.decodeEffect(Schema.fromJsonString(TopicArchiveInput))(text, {
						onExcessProperty: "error",
					}).pipe(Effect.mapError(() => new KernelError({ code: "input_invalid" })))
				: yield* Schema.decodeEffect(Schema.fromJsonString(TopicMetaInput))(text, { onExcessProperty: "error" }).pipe(
						Effect.mapError(() => new KernelError({ code: "input_invalid" })),
					);

			return HttpServerResponse.jsonUnsafe(
				yield* (yield* Messages).topic(who, path, input, request.headers["idempotency-key"]),
			);
		}),
	);
export const topicManagementHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "topicManagement", (handlers) =>
		handlers
			.handleRaw("move", () =>
				Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: "boot_route_required" } }, { status: 503 })),
			)
			.handleRaw("meta", () => mutate(false))
			.handleRaw("archive", () => mutate(true))
			.handleRaw("delete", () =>
				failure(
					Effect.gen(function* () {
						const who = yield* identity("write");
						const request = yield* HttpServerRequest.HttpServerRequest;
						const url = new URL(request.url, "http://localhost");
						if (url.search) return yield* new KernelError({ code: "query_invalid" });
						const path = yield* Effect.try({
							try: () => decodeURIComponent(url.pathname.slice("/api/topics/".length)),
							catch: () => new KernelError({ code: "input_invalid" }),
						});
						return HttpServerResponse.jsonUnsafe(
							yield* (yield* Messages).deleteTopic(who, path, request.headers["idempotency-key"]),
						);
					}),
				),
			),
	);
