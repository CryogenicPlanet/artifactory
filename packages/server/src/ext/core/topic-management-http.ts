import type { HttpServerRequest } from "effect/unstable/http";
import type { TopicPayload } from "@comms/protocol/topic-management-http";

import { Pages } from "./pages.ts";
import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";

import { layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { CoreApi as Api } from "@comms/protocol";
import { refusal } from "../../conversation-request.ts";
import { KernelError } from "../../kernel/boot-channel.ts";

import { moveTopic } from "./topic-move.ts";

import { mutateTopic } from "./topic-operations.ts";

export const topicManagementHandlers = (api: typeof Api, extension: ExtensionApi) => {
	const move = ({
		payload,
		request,
	}: {
		readonly payload: { readonly to: string };
		readonly request: HttpServerRequest.HttpServerRequest;
	}) =>
		refusal(
			Effect.gen(function* () {
				const ctx = yield* extension.context("write");
				const path = yield* Effect.try({
					try: () => decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice("/api/topics/".length)),
					catch: () => new KernelError({ code: "input_invalid" }),
				});
				if (!path.endsWith("/move")) return yield* new KernelError({ code: "input_invalid" });
				return yield* moveTopic(
					ctx.db,
					ctx.mutate,
					ctx,
					ctx,
					path.slice(0, -5),
					payload.to,
					(yield* Pages).move,
					request.headers["idempotency-key"],
				);
			}),
		);
	const meta = ({
		payload,
		request,
	}: {
		readonly payload: typeof TopicPayload.Type;
		readonly request: HttpServerRequest.HttpServerRequest;
	}) =>
		refusal(
			Effect.gen(function* () {
				const ctx = yield* extension.context("write");
				const path = yield* Effect.try({
					try: () => decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice("/api/topics/".length)),
					catch: () => new KernelError({ code: "input_invalid" }),
				});
				return yield* "meta" in payload
					? ctx.topics.meta(path, payload.meta, request.headers["idempotency-key"])
					: mutateTopic(ctx.db, ctx.mutate, ctx, ctx, path, payload, request.headers["idempotency-key"]);
			}),
		);
	return HttpApiBuilder.group(api, "topicManagement", (handlers) =>
		handlers.handle("move", move).handle("legacyMove", move).handle("meta", meta).handle("legacyMeta", meta),
	).pipe(Layer.provide(bodyLayer(131072)));
};
