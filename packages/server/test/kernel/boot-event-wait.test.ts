import { it } from "@effect/vitest";
import { expect } from "vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { BootChannel, layer } from "../../src/kernel/boot-channel.ts";

it.effect("keeps event long polls open beyond the ordinary channel timeout and retains drained responses", () =>
	Effect.gen(function* () {
		const requested = yield* Deferred.make<string>();
		const release = yield* Deferred.make<void>();
		const body = { items: [], cursor: 17, timed_out: false, drained: true };
		const client = HttpClient.make((request) =>
			Effect.gen(function* () {
				yield* Deferred.succeed(requested, request.url);
				yield* Deferred.await(release);
				return HttpClientResponse.fromWeb(request, Response.json(body));
			}),
		);
		const request = Effect.gen(function* () {
			const boot = yield* BootChannel;
			return yield* boot.events({ since: 4, limit: 200, wait: 60, types: ["message.*", "topic.*", "sql.write"] });
		}).pipe(
			Effect.provide(
				layer.pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.succeed(HttpClient.HttpClient, client),
							ConfigProvider.layer(
								ConfigProvider.fromUnknown({
									WRITER_EPOCH: "epoch",
									APP_DATABASE: "unused.db",
									GENERATION: "1",
									STATE: "live",
									BOOT_URL: "http://localhost",
									BOOT_SECRET: "secret",
								}),
							),
						),
					),
				),
			),
		);
		const fiber = yield* request.pipe(Effect.forkScoped);
		const url = new URL(yield* Deferred.await(requested));
		expect(url.searchParams.get("wait")).toBe("60");
		expect(url.searchParams.get("types")).toBe("message.*,topic.*,sql.write");
		yield* TestClock.adjust("2 seconds");
		yield* Deferred.succeed(release, undefined);
		expect(yield* Fiber.join(fiber)).toEqual(body);
	}),
);
