import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorSchemas } from "../src/error-contract.ts";
import { Cause, Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { ConnectionError, SqlError, SqlSyntaxError } from "effect/unstable/sql/SqlError";
import { expect, it } from "vitest";
import { failure, refusal } from "../src/conversation-request.ts";
import { KernelError } from "../src/kernel/boot-channel.ts";
import { boundedRequest, RequestValidation, layer as bodyLayer } from "../src/request-schema.ts";

it("preserves actionable typed refusals and only retries known infrastructure failures", async () => {
	const request = HttpServerRequest.fromWeb(new Request("http://localhost/api/messages?secret=not-public"));
	for (const [error, status, code] of [
		[new KernelError({ code: "scope_required" }), 403, "scope_required"],
		[new KernelError({ code: "topic_not_found" }), 404, "topic_not_found"],
		[new KernelError({ code: "topic_archived" }), 409, "topic_archived"],
		[new KernelError({ code: "cursor_ahead" }), 400, "cursor_ahead"],
		[new KernelError({ code: "boot_unavailable" }), 503, "boot_unavailable"],
		[new SqlError({ reason: new ConnectionError({ cause: null }) }), 503, "store_unavailable"],
		[new SqlError({ reason: new SqlSyntaxError({ cause: null, message: "private SQL text" }) }), 500, "handler_failed"],
	] as const) {
		const response = await Effect.runPromise(
			failure(Effect.fail(error)).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
		);
		expect(response.status).toBe(status);
		const body = await Effect.runPromise(HttpServerResponse.toClientResponse(response).json);
		expect(body).toMatchObject({ error: { code, retriable: status === 503, hint: expect.any(String) } });
		expect(JSON.stringify(body)).not.toContain("private SQL text");
	}
});

it("reports unknown failures and defects as route-named 500s without exposing thrown contents", async () => {
	const request = HttpServerRequest.fromWeb(
		new Request("http://localhost/api/messages?secret=not-public", { method: "POST" }),
	);
	class Unexpected extends Data.TaggedError("Unexpected")<{ readonly message: string }> {}
	const attempts: ReadonlyArray<Effect.Effect<never, KernelError | Unexpected>> = [
		Effect.fail(new Unexpected({ message: "private failure" })),
		Effect.die("private defect"),
		Effect.die(new KernelError({ code: "boot_unavailable" })),
		Effect.failCause(
			Cause.combine(Cause.fail(new KernelError({ code: "boot_unavailable" })), Cause.die("private finalizer defect")),
		),
	];
	for (const effect of attempts) {
		const response = await Effect.runPromise(
			failure(effect).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
		);
		expect(response.status).toBe(500);
		const body = await Effect.runPromise(HttpServerResponse.toClientResponse(response).json);
		expect(body).toMatchObject({
			error: { code: "handler_failed", retriable: false, message: "Handler failed for POST /api/messages." },
		});
		expect(JSON.stringify(body)).not.toMatch(/private|not-public/);
	}
});

it("runs declared payload, query and success schemas with bounded request bodies", async () => {
	const api = HttpApi.make("contract-test").add(
		HttpApiGroup.make("test").add(
			HttpApiEndpoint.post("echo", "/api/echo", {
				payload: Schema.Struct({ count: Schema.Int }),
				query: Schema.Struct({
					mode: Schema.optionalKey(Schema.Literals(["ok", "invalid-result", "refused"])),
				}),
				success: Schema.Struct({ count: Schema.Int }),
				error: errorSchemas,
			}).middleware(RequestValidation),
		),
	);
	let called = 0;
	const handlers = HttpApiBuilder.group(api, "test", (handlers) =>
		handlers.handle("echo", ({ payload, query }) =>
			refusal(
				Effect.gen(function* () {
					called++;
					if (query.mode === "refused") return yield* new KernelError({ code: "author_required" });
					return { count: query.mode === "invalid-result" ? Number.NaN : payload.count };
				}),
			),
		),
	).pipe(Layer.provide(bodyLayer(64)));
	const routes = HttpApiBuilder.layer(api).pipe(Layer.provide(handlers));
	const platform = HttpServer.layerServices;
	const dispatch = HttpRouter.toHttpEffect(routes).pipe(Effect.provide(platform));
	const post = (body: string, query = "") =>
		Effect.runPromise(
			Effect.gen(function* () {
				const handler = yield* dispatch;
				const request = HttpServerRequest.fromWeb(
					new Request(`http://localhost/api/echo${query}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					}),
				);
				return HttpServerResponse.toWeb(
					yield* failure(handler).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
				);
			}).pipe(Effect.scoped),
		);
	const success = await post('{"count":7}');
	expect(success.status).toBe(200);
	expect(await success.json()).toEqual({ count: 7 });
	for (const [body, query, code] of [
		['{"count":"7"}', "", "input_invalid"],
		['{"count":7,"extra":true}', "", "input_invalid"],
		['{"count":', "", "input_invalid"],
		['{"count":7}', "?unknown=1", "query_invalid"],
		['{"count":7}', "?mode=ok&mode=ok", "query_invalid"],
		['{"count":7}', "?mode=wrong", "query_invalid"],
		[" ".repeat(65) + '{"count":7}', "", "input_invalid"],
	] as const) {
		const response = await post(body, query);
		expect(response.status, `${body} ${query}`).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code, retriable: false } });
	}
	expect(called).toBe(1);
	const refused = await post('{"count":7}', "?mode=refused");
	expect(refused.status).toBe(403);
	expect(await refused.json()).toMatchObject({ error: { code: "author_required" } });
	const invalid = await post('{"count":7}', "?mode=invalid-result");
	expect(invalid.status).toBe(500);
	expect(await invalid.json()).toMatchObject({ error: { code: "handler_failed", retriable: false } });
});

it("preserves binary payload bytes while buffering the shared request boundary", async () => {
	const request = HttpServerRequest.fromWeb(
		new Request("http://localhost/api/binary", {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: new Uint8Array([255, 0, 128, 65]),
		}),
	);
	const buffered = await Effect.runPromise(
		boundedRequest(4).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
	);
	const bytes = await Effect.runPromise(buffered.arrayBuffer);
	expect(Array.from(new Uint8Array(bytes))).toEqual([255, 0, 128, 65]);
});

it("executes retained HttpApi error codecs and OpenAPI status contracts", async () => {
	const { stdout } = await promisify(execFile)("bun", [new URL("./fixtures/http-errors.ts", import.meta.url).pathname]);
	expect(stdout).toContain("HTTP error contracts passed");
});
