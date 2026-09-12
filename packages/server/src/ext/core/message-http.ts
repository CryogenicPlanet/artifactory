import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";

import { layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { CoreApi as Api } from "@comms/protocol";
import { refusal } from "../../conversation-request.ts";

import { mutateMessage } from "./message-operations.ts";

export const messageHandlers = (api: typeof Api, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "message", (handlers) =>
		handlers
			.handle("update", ({ params, payload, request }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("write");
						return yield* mutateMessage(
							ctx.db,
							ctx.mutate,
							ctx,
							ctx,
							params.ref,
							payload,
							request.headers["idempotency-key"],
						);
					}),
				),
			)
			.handle("remove", ({ params, request }) =>
				refusal(
					Effect.gen(function* () {
						const ctx = yield* extension.context("write");
						return yield* mutateMessage(
							ctx.db,
							ctx.mutate,
							ctx,
							ctx,
							params.ref,
							null,
							request.headers["idempotency-key"],
						);
					}),
				),
			),
	).pipe(Layer.provide(bodyLayer(131072)));
