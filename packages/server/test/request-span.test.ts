import { spanHeader, traceparentHeader } from "@comms/protocol/headers";
import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { RequestSpan, requestSpan } from "../src/kernel/request-span.ts";

it("continues only trusted trace context and returns bounded selected annotations", async () => {
	const traceId = "12345678901234567890123456789012",
		parentId = "1234567890123456";
	const response = await Effect.runPromise(
		requestSpan(
			Effect.gen(function* () {
				const span = yield* Effect.currentSpan;
				expect(span.traceId).toBe(traceId);
				expect(Option.getOrUndefined(span.parent)?.spanId).toBe(parentId);
				span.attribute("authorization", "private");
				span.attribute("topic", "project/task");
				span.attribute("message_id", "m_123");
				span.attribute("lock_state", "x".repeat(201));
				yield* Effect.gen(function* () {
					const root = yield* RequestSpan;
					root?.attribute("extension", "core.ts");
				}).pipe(Effect.withSpan("nested.database"));
				return HttpServerResponse.empty();
			}),
		).pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(
					new Request("http://localhost/api/messages", {
						headers: { [traceparentHeader]: `00-${traceId}-${parentId}-01` },
					}),
				),
			),
		),
	);
	expect(JSON.parse(decodeURIComponent(response.headers[spanHeader] ?? ""))).toEqual({
		topic: "project/task",
		message_id: "m_123",
		extension: "core.ts",
	});
});

it("does not adopt public or malformed trace headers", async () => {
	for (const headers of [
		{ traceparent: "00-12345678901234567890123456789012-1234567890123456-01" },
		{ [traceparentHeader]: "malformed" },
		{ [traceparentHeader]: "00-00000000000000000000000000000000-1234567890123456-01" },
	]) {
		const response = await Effect.runPromise(
			requestSpan(
				Effect.gen(function* () {
					expect(yield* RequestSpan).toBeUndefined();
					return HttpServerResponse.empty();
				}),
			).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(new Request("http://localhost/", { headers })),
				),
			),
		);
		expect(response.headers[spanHeader]).toBeUndefined();
	}
});
