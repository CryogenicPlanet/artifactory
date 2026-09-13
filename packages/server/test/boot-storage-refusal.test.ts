import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { BootChannel, layer } from "../src/kernel/boot-channel.ts";
import { failure } from "../src/conversation-request.ts";

it("preserves boot storage refusals with distinct quota and measurement retry semantics", async () => {
	for (const [status, body, expectedStatus, expectedCode] of [
		[507, { error: { code: "storage_headroom" } }, 507, "storage_headroom"],
		[507, { error: { code: "backup_budget" } }, 507, "backup_budget"],
		[507, { error: { code: "invalid_storage_sample" } }, 507, "invalid_storage_sample"],
		[507, { error: { code: "event_storage_over_budget" } }, 507, "event_storage_over_budget"],
		[503, { error: { code: "event_storage_unavailable" } }, 503, "event_storage_unavailable"],
		[503, { error: { code: "storage_measurement_failed" } }, 503, "storage_measurement_failed"],
		[507, { error: { code: "unrecognized" } }, 503, "boot_unavailable"],
		[503, { error: { code: "unrecognized" } }, 503, "boot_unavailable"],
		[507, { error: { code: "event_storage_unavailable" } }, 503, "boot_unavailable"],
		[503, { error: { code: "storage_headroom" } }, 503, "boot_unavailable"],
		[409, { error: { code: "unsafe_artifact_path" } }, 409, "unsafe_artifact_path"],
		[409, { error: { code: "unrecognized" } }, 503, "boot_unavailable"],
	] as const) {
		const client = HttpClient.make((request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
		);
		const response = await Effect.runPromise(
			Effect.gen(function* () {
				const boot = yield* BootChannel;
				return yield* failure(
					(status === 409 ? boot.backup : boot.reserve("original-transaction", 1)).pipe(
						Effect.andThen(Effect.die("Unexpected operation success")),
					),
				);
			}).pipe(
				Effect.provide(
					layer.pipe(
						Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
						Layer.provide(
							ConfigProvider.layer(
								ConfigProvider.fromUnknown({
									WRITER_EPOCH: "epoch",
									APP_STORE: "file:/unused.db",
									APP_DATABASE: "/unused.db",
									GENERATION: "1",
									STATE: "live",
									BOOT_URL: "http://localhost",
									BOOT_SECRET: "secret",
								}),
							),
						),
					),
				),
				Effect.scoped,
			),
		);
		expect(response.status).toBe(expectedStatus);
		expect(await Effect.runPromise(HttpServerResponse.toClientResponse(response).json)).toMatchObject({
			error: { code: expectedCode, retriable: expectedStatus === 503, hint: expect.any(String) },
		});
	}
});
