import type { HttpServerRequest } from "effect/unstable/http";
import type { TopicQuery } from "@comms/protocol/topics-http";

import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";

import { layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { CoreApi as Api } from "@comms/protocol";
import { refusal } from "../../conversation-request.ts";
import { KernelError } from "../../kernel/boot-channel.ts";

import { markView } from "./read-view.ts";

export const topicHandlers = (api: typeof Api, extension: ExtensionApi) => {
	const detail = ({
		query,
		request,
	}: {
		readonly query: typeof TopicQuery.Type;
		readonly request: HttpServerRequest.HttpServerRequest;
	}) =>
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
		);
	return HttpApiBuilder.group(api, "topics", (handlers) =>
		handlers.handle("detail", detail).handle("legacyDetail", detail),
	).pipe(Layer.provide(bodyLayer(131072)));
};
