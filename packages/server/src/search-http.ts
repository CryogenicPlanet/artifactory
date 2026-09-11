import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity, integer } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { Envelope } from "./kernel/messages.ts";
import { Search } from "./kernel/search.ts";

export const searchGroup = HttpApiGroup.make("search").add(
	HttpApiEndpoint.get("search", "/api/search", {
		query: {
			q: Schema.String,
			topic: Schema.optionalKey(Schema.String),
			since: Schema.optionalKey(Schema.String),
			limit: Schema.optionalKey(Schema.String),
		},
		success: Envelope,
	}).annotate(
		OpenApi.Description,
		"Search published message bodies using Unicode full-text terms and double-quoted phrases, combined with AND. Requires read. q is 1–512 characters with at most16 terms/phrases; topic includes its subtree, including archived topics. since defaults to0; limit defaults to100, maximum200. Results use ascending creation sequence; cursor preserves since when empty. Re-run from0 to discover later edits. No raw FTS operators, ranking, stemming or page search.",
	),
);
export const searchHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "search", (handlers) =>
		handlers.handleRaw("search", () =>
			failure(
				Effect.gen(function* () {
					yield* identity("read");
					const request = yield* HttpServerRequest.HttpServerRequest;
					const params = new URL(request.url, "http://localhost").searchParams;
					if (
						[...params.keys()].some(
							(key) => !["q", "topic", "since", "limit"].includes(key) || params.getAll(key).length !== 1,
						)
					)
						return yield* new KernelError({ code: "query_invalid" });
					const q = params.get("q"),
						topic = params.get("topic"),
						since = integer(params.get("since"), 0, Number.MAX_SAFE_INTEGER),
						limit = integer(params.get("limit"), 100, 200);
					if (q === null || since === null || limit === null) return yield* new KernelError({ code: "query_invalid" });
					return HttpServerResponse.jsonUnsafe(
						yield* (yield* Search).find({ q, since, limit, ...(topic === null ? {} : { topic }) }),
					);
				}),
			),
		),
	);
