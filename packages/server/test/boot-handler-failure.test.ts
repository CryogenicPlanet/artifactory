import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { BootChannel, type KernelError, layer } from "../src/kernel/boot-channel.ts";
import { failure } from "../src/conversation-request.ts";

it("retains nonretryable boot handler failures through mutation, query, backup and cached-fence operations", async () => {
	for (const operation of ["reserve", "append", "abort", "events", "backup", "fence", "changed"] as const) {
		const client = HttpClient.make((request) => {
			const firstFence = operation === "changed" && request.url === "http://localhost/_boot/seq";
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					Response.json(
						firstFence ? { published_through: 0 } : { error: { code: "handler_failed", retriable: false } },
						{ status: firstFence ? 200 : 500 },
					),
				),
			);
		});
		const response = await Effect.runPromise(
			Effect.gen(function* () {
				const boot = yield* BootChannel;
				const request: Effect.Effect<unknown, KernelError> =
					operation === "reserve"
						? boot.reserve("original", 1)
						: operation === "append"
							? boot.append({ transaction: "original", from: 1, to: 1, events: [] })
							: operation === "abort"
								? boot.abort("original")
								: operation === "events"
									? boot.events({ limit: 1, since: 0 })
									: operation === "backup"
										? boot.backup
										: operation === "changed"
											? boot.changed(0)
											: boot.fence;
				return yield* failure(request.pipe(Effect.asVoid));
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
		if (!response) throw new Error(`Unexpected success: ${operation}`);
		expect(response.status, operation).toBe(500);
		expect(await Effect.runPromise(HttpServerResponse.toClientResponse(response).json)).toMatchObject({
			error: { code: "boot_handler_failed", retriable: false },
		});
	}
});
