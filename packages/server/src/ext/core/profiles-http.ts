import { errorSchemas } from "../../error-contract.ts";
import type { Api as ExtensionApi } from "../../kernel/extension-api.ts";
import { RequestValidation, layer as bodyLayer } from "../../request-schema.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./api.ts";
import { refusal } from "../../conversation-request.ts";
import { KernelError } from "../../kernel/boot-channel.ts";
const Me = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["agent", "human"]),
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
});
export const profilesGroup = HttpApiGroup.make("profiles")
	.add(
		HttpApiEndpoint.get("me", "/api/me", {
			error: errorSchemas,
			query: Schema.Record(Schema.String, Schema.Never),
			success: HttpApiSchema.WithHeaders(Me, { "cache-control": Schema.Literal("no-store") }),
		}).annotate(
			OpenApi.Description,
			"Read verified caller identity, granted scopes and credential expiry in epoch milliseconds. Requires read. No credential is returned.",
		),
	)
	.middleware(RequestValidation);
export const profilesHandlers = (api: typeof Api, extension: ExtensionApi) =>
	HttpApiBuilder.group(api, "profiles", (handlers) =>
		handlers.handle("me", ({ request }) =>
			refusal(
				Effect.gen(function* () {
					const ctx = yield* extension.context("read");
					const expires = Number(request.headers["x-comms-token-expires"]);
					if (!Number.isSafeInteger(expires) || expires <= 0) return yield* new KernelError({ code: "scope_required" });
					return HttpApiSchema.withHeaders({
						body: {
							agent: ctx.agent,
							instance: ctx.instance,
							kind: ctx.kind,
							label: ctx.label ?? "",
							scopes: request.headers["x-comms-scopes"]?.split(",") ?? [],
							expires_at: expires,
						},
						headers: { "cache-control": "no-store" as const },
					});
				}),
			),
		),
	).pipe(Layer.provide(bodyLayer(131072)));
