import { scopesHeader, tokenExpiresHeader } from "@comms/protocol/headers";
import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";

import { layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer } from "effect";
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi";
import type { CoreApi as Api } from "@comms/protocol";
import { refusal } from "../../conversation-request.ts";
import { KernelError } from "../../kernel/boot-channel.ts";
export const profilesHandlers = (api: typeof Api, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "profiles", (handlers) =>
		handlers.handle("me", ({ request }) =>
			refusal(
				Effect.gen(function* () {
					const ctx = yield* extension.context("read");
					const expires = Number(request.headers[tokenExpiresHeader]);
					if (!Number.isSafeInteger(expires) || expires <= 0) return yield* new KernelError({ code: "scope_required" });
					return HttpApiSchema.withHeaders({
						body: {
							agent: ctx.agent,
							instance: ctx.instance,
							kind: ctx.kind,
							label: ctx.label ?? "",
							scopes: request.headers[scopesHeader]?.split(",") ?? [],
							expires_at: expires,
						},
						headers: { "cache-control": "no-store" as const },
					});
				}),
			),
		),
	).pipe(Layer.provide(bodyLayer(131072)));
