import { expect } from "bun:test";
import { Api } from "../../src/ext/core/api.ts";
import { SystemApi } from "../../src/conversation.ts";
import { definition as subscriptionApi } from "../../src/ext/subscriptions/index.ts";
import { respond } from "../../src/ext/subscriptions/response.ts";
import { SubscriptionError } from "../../src/ext/subscriptions/contract.ts";
import { ErrorEnvelope } from "../../src/error-contract.ts";
import { KernelError } from "../../src/kernel/boot-channel.ts";
import { failure, refusal } from "../../src/conversation-request.ts";
import { layer as bodyLayer } from "../../src/request-schema.ts";
import { Cause, Effect, Exit, JsonSchema, Layer, Schema, SchemaRepresentation } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi";
const core = async () => {
	const api = HttpApi.make("error-execution").add(Api.groups.profiles);
	const cases: ReadonlyArray<{
		readonly effect: Effect.Effect<never, KernelError | string>;
		readonly status: number;
		readonly code: string;
	}> = [
		{ effect: Effect.fail(new KernelError({ code: "input_invalid" })), status: 400, code: "input_invalid" },
		{ effect: Effect.fail(new KernelError({ code: "scope_required" })), status: 403, code: "scope_required" },
		{
			effect: Effect.fail(new KernelError({ code: "idempotency_conflict" })),
			status: 409,
			code: "idempotency_conflict",
		},
		{ effect: Effect.fail(new KernelError({ code: "storage_headroom" })), status: 507, code: "storage_headroom" },
		{ effect: Effect.fail(new KernelError({ code: "boot_unavailable" })), status: 503, code: "boot_unavailable" },
		{ effect: Effect.fail("private unknown failure"), status: 500, code: "handler_failed" },
		{ effect: Effect.die("private defect"), status: 500, code: "handler_failed" },
		{
			effect: Effect.failCause(
				Cause.combine(Cause.fail(new KernelError({ code: "boot_unavailable" })), Cause.die("private finalizer defect")),
			),
			status: 500,
			code: "handler_failed",
		},
	];
	for (const sample of cases) {
		const handlers = HttpApiBuilder.group(api, "profiles", (handlers) =>
			handlers.handle("me", () => refusal(sample.effect)),
		).pipe(Layer.provide(bodyLayer(64)));
		const routes = HttpApiBuilder.layer(api).pipe(Layer.provide(handlers));
		const response = await Effect.runPromise(
			Effect.gen(function* () {
				const handler = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provide(HttpServer.layerServices));
				// No outer failure wrapper: the declared HttpApi error encoder produces this response.
				return HttpServerResponse.toWeb(
					yield* handler.pipe(
						Effect.provideService(
							HttpServerRequest.HttpServerRequest,
							HttpServerRequest.fromWeb(new Request("http://localhost/api/me")),
						),
					),
				);
			}).pipe(Effect.scoped),
		);
		expect(response.status).toBe(sample.status);
		const body = await response.json();
		expect(body).toMatchObject({ error: { code: sample.code, retriable: sample.status === 503 } });
		expect(Schema.is(ErrorEnvelope)(body)).toBe(true);
		expect(JSON.stringify(body)).not.toContain("private");
		if (sample.status === 500) expect(body).toMatchObject({ error: { message: "Handler failed for GET /api/me." } });
		for (const document of [OpenApi.fromApi(Api), OpenApi.fromApi(SystemApi), OpenApi.fromApi(subscriptionApi)]) {
			for (const item of Object.values(document.paths)) {
				for (const operation of [item.get, item.post, item.put, item.patch, item.delete]) {
					if (!operation) continue;
					const schema = operation.responses[sample.status]?.content?.["application/json"]?.schema;
					if (!schema) throw new Error(`Missing ${sample.status} error schema for ${operation.operationId}`);
					const codec = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaOpenApi3_1(schema));
					expect(Schema.is(codec)(body), `${operation.operationId}: ${sample.status}`).toBe(true);
					expect(Schema.is(codec)({ error: { code: sample.code } })).toBe(false);
					expect(
						Schema.is(codec)({ error: { code: "not_a_declared_code", message: "x", hint: "x", retriable: false } }),
					).toBe(false);
					for (const [status, other] of Object.entries(operation.responses)) {
						if (status === String(sample.status) || !other.content?.["application/json"]?.schema) continue;
						if (!Number.isSafeInteger(Number(status)) || Number(status) < 400) continue;
						const otherCodec = SchemaRepresentation.fromJsonSchemaDocument(
							JsonSchema.fromSchemaOpenApi3_1(other.content["application/json"].schema),
						);
						expect(Schema.is(otherCodec)(body), `${operation.operationId}: erroneous ${status}`).toBe(false);
					}
				}
			}
		}
	}
};

const subscriptions = async () => {
	const api = subscriptionApi;
	const known = new SubscriptionError({ code: "subscription_limit", status: 409 });
	for (const [effect, status, code] of [
		[Effect.fail(known), 409, "subscription_limit"],
		[Effect.fail(new SubscriptionError({ code: "event_cursor_invalid", status: 503 })), 503, "event_cursor_invalid"],
		[Effect.fail(new KernelError({ code: "scope_required" })), 403, "scope_required"],
		[Effect.fail(new KernelError({ code: "storage_headroom" })), 507, "storage_headroom"],
		[Effect.fail("private unknown"), 500, "handler_failed"],
		[Effect.die("private defect"), 500, "handler_failed"],
		[Effect.failCause(Cause.combine(Cause.fail(known), Cause.die("private finalizer defect"))), 500, "handler_failed"],
	] satisfies ReadonlyArray<
		readonly [Effect.Effect<never, KernelError | SubscriptionError | string>, number, string]
	>) {
		const handlers = HttpApiBuilder.group(api, "subscriptions", (handlers) =>
			handlers
				.handle("list", () => respond<never, KernelError | SubscriptionError | string, never>(effect))
				.handle("create", () => respond(Effect.fail(known)))
				.handle("remove", () => respond(Effect.fail(known))),
		);
		const response = await Effect.runPromise(
			Effect.gen(function* () {
				const handler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(api).pipe(Layer.provide(handlers))).pipe(
					Effect.provide(HttpServer.layerServices),
				);
				return HttpServerResponse.toWeb(
					yield* handler.pipe(
						Effect.provideService(
							HttpServerRequest.HttpServerRequest,
							HttpServerRequest.fromWeb(new Request("http://localhost/api/subscriptions?secret=private")),
						),
					),
				);
			}).pipe(Effect.scoped),
		);
		expect(response.status).toBe(status);
		const body = await response.json();
		expect(body).toMatchObject({ error: { code, retriable: status === 503 } });
		const responses = OpenApi.fromApi(api).paths["/api/subscriptions"]?.get?.responses;
		if (!responses) throw new Error("Missing subscription responses");
		for (const [declaredStatus, response] of Object.entries(responses)) {
			if (Number(declaredStatus) < 400 || !response.content?.["application/json"]?.schema) continue;
			const codec = SchemaRepresentation.fromJsonSchemaDocument(
				JsonSchema.fromSchemaOpenApi3_1(response.content["application/json"].schema),
			);
			expect(Schema.is(codec)(body), `${code} under ${declaredStatus}`).toBe(Number(declaredStatus) === status);
		}
		if (status === 500)
			expect(body).toMatchObject({ error: { message: "Handler failed for GET /api/subscriptions." } });
		expect(JSON.stringify(body)).not.toContain("private");
	}
	for (const wrap of [refusal, failure, respond]) {
		const exit = await Effect.runPromise(Effect.exit(wrap(Effect.interrupt)));
		expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
	}
};

await core();
await subscriptions();
console.log("HTTP error contracts passed");
