import { CoreApi as Api } from "@comms/protocol";

import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";
import { streamHandlers } from "../../stream-http.ts";

import { layer as bodyLayer } from "../../request-schema.ts";
import { profilesHandlers } from "./profiles-http.ts";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { refusal } from "../../conversation-request.ts";
import { topicManagementHandlers } from "./topic-management-http.ts";
import { messageHandlers } from "./message-http.ts";
import { topicHandlers } from "./topics-http.ts";
import { KernelError } from "../../kernel/boot-channel.ts";
import { Envelope } from "@comms/protocol/messages";
import { validTopic } from "./messages.ts";
import { waitForMessages } from "./message-wait.ts";
import { markView } from "./read-view.ts";

const handlers = (extension: ExtensionApi) =>
	HttpApiBuilder.group(Api, "conversation", (handlers) =>
		handlers
			.handle("create", ({ payload, request }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("write");
						return yield* ctx.messages.create(payload, request.headers["idempotency-key"]);
					}),
				),
			)
			.handle("messages", ({ query }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("read");
						const limit = query.limit ?? 100,
							wait = query.wait ?? 0;
						if ((query.topic !== undefined && !validTopic(query.topic)) || (query.newest === "1" && wait > 0))
							return yield* new KernelError({ code: "query_invalid" });
						const cursor =
							query.since !== undefined
								? query.since
								: query.newest === "1"
									? 0
									: (yield* ctx.publicationFence).published_through;
						const input = {
							since: cursor,
							limit,
							...(query.topic === undefined ? {} : { topic: query.topic }),
							recursive: query.recursive === "1",
							newest: query.newest === "1",
							...(query.tag === undefined ? {} : { tag: query.tag }),
							...(query.agent === undefined ? {} : { agent: query.agent }),
							...(query.q === undefined ? {} : { q: query.q }),
							...(query.mentions === undefined ? {} : { mentions: query.mentions.split(",") }),
							...(wait > 0 || query.exclude_self === "1" ? { exclude: ctx.instance } : {}),
						};
						const view = (result: typeof Envelope.Type) =>
							markView(
								ctx,
								result.items,
								query.topic ?? "",
								query.mark !== "0" && (query.topic !== undefined || query.mentions === undefined),
							).pipe(Effect.as(result));
						const first = yield* ctx.messages.query(input);
						if (first.items.length || wait === 0) return yield* view(first);
						const deadline = (yield* DateTime.nowAsDate).getTime() + wait * 1000;
						const result = waitForMessages({
							first,
							deadline,
							changed: ctx.events.changed,
							query: (since) => ctx.messages.query({ ...input, since }),
							view,
							drained: ctx.drained,
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
				),
			),
	).pipe(Layer.provide(bodyLayer(131072)));
export const coreHandlers = (extension: ExtensionApi) =>
	Layer.mergeAll(
		handlers(extension),
		topicHandlers(Api, extension),
		messageHandlers(Api, extension),
		topicManagementHandlers(Api, extension),
		profilesHandlers(Api, extension),
		streamHandlers(Api, extension),
	);
