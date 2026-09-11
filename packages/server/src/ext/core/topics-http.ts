import { errorSchemas } from "../../error-contract.ts";
import { queryInteger } from "../../query-number.ts";
import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";
import { RequestValidation, layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./api.ts";
import { refusal } from "../../conversation-request.ts";
import { KernelError } from "../../kernel/boot-channel.ts";
import { TopicResult } from "./topics.ts";
import { markView } from "./read-view.ts";

const query = Schema.Struct({
	depth: Schema.optionalKey(queryInteger(1, 200)),
	archived: Schema.optionalKey(Schema.Literals(["0", "1"])),
	mark: Schema.optionalKey(Schema.Literals(["0", "1"])),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const topicsGroup = HttpApiGroup.make("topics")
	.add(
		HttpApiEndpoint.get("detail", "/api/topics/*", { error: errorSchemas, query, success: TopicResult }).annotate(
			OpenApi.Description,
			"Read a topic, subtopics, latest 100 messages and pages. GET /api/topics is the root alias. Requires read. The snapshot fence is not a pagination cursor. Views mark the highest returned message sequence; mark=0 peeks. Archived children require archived=1.",
		),
	)
	.middleware(RequestValidation);
export const topicHandlers = (api: typeof Api, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "topics", (handlers) =>
		handlers.handle("detail", ({ query, request }) =>
			refusal(
				Effect.gen(function* () {
					const ctx = yield* extension.context("read");
					const depth = query.depth ?? 1;
					const url = new URL(request.url, "http://localhost");
					const path =
						url.pathname === "/api/topics"
							? ""
							: yield* Effect.try({
									try: () => decodeURIComponent(url.pathname.slice("/api/topics/".length)),
									catch: () => new KernelError({ code: "query_invalid" }),
								});
					const result = yield* ctx.topics.read(path, { depth, archived: query.archived === "1" });
					yield* markView(ctx, result.messages, path, query.mark !== "0");
					return result;
				}),
			),
		),
	).pipe(Layer.provide(bodyLayer(131072)));
