import { it } from "@effect/vitest";
import { expect } from "vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { BootChannel, layer } from "../src/kernel/boot-channel.ts";

it.effect("shares one idle boot wait, advances from append acknowledgements, and observes boot-only publications", () =>
	Effect.gen(function* () {
		const queries = yield* Ref.make<readonly string[]>([]);
		const bootChange = yield* Deferred.make<number>();
		const waiting = yield* Deferred.make<void>();
		const client = HttpClient.make((request, url) =>
			Effect.gen(function* () {
				yield* Ref.update(queries, (paths) => [...paths, url.pathname + url.search]);
				let value = 10;
				if (url.pathname === "/_boot/events/append") value = 12;
				else if (url.searchParams.has("wait")) {
					yield* Deferred.succeed(waiting, undefined);
					if (Number(url.searchParams.get("since")) >= 15) return yield* Effect.never;
					value = yield* Deferred.await(bootChange);
				}
				return HttpClientResponse.fromWeb(request, Response.json({ published_through: value }));
			}),
		);
		yield* Effect.gen(function* () {
			const boot = yield* BootChannel;
			expect(yield* boot.fence).toEqual({ published_through: 10 });
			yield* Deferred.await(waiting);
			const waiters = yield* Effect.all(Array.from({ length: 10 }, () => boot.changed(10).pipe(Effect.forkScoped)));
			for (let index = 0; index < 50; index++) expect(yield* boot.fence).toEqual({ published_through: 10 });
			yield* TestClock.adjust("20 seconds");
			expect(yield* Ref.get(queries)).toEqual(["/_boot/seq", "/_boot/seq?since=10&wait=60"]);
			yield* boot.append({ transaction: "tx", from: 11, to: 12, events: [] });
			for (const waiter of waiters) expect(yield* Fiber.join(waiter)).toBe(12);
			expect(yield* boot.fence).toEqual({ published_through: 12 });
			const bootWaiter = yield* boot.changed(12).pipe(Effect.forkScoped);
			yield* Deferred.succeed(bootChange, 15);
			expect(yield* Fiber.join(bootWaiter)).toBe(15);
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
		);
	}),
);

it.effect("releases cached-fence waiters on channel failure and resumes after recovery", () =>
	Effect.gen(function* () {
		const failed = yield* Deferred.make<void>();
		const client = HttpClient.make((request, url) =>
			Effect.gen(function* () {
				if (!url.searchParams.has("wait"))
					return HttpClientResponse.fromWeb(
						request,
						Response.json({ published_through: url.pathname === "/_boot/events/append" ? 4 : 3 }),
					);
				yield* Deferred.await(failed);
				return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
			}),
		);
		yield* Effect.gen(function* () {
			const boot = yield* BootChannel;
			yield* boot.fence;
			const waiter = yield* boot.changed(3).pipe(Effect.result, Effect.forkScoped);
			yield* Deferred.succeed(failed, undefined);
			expect(yield* Fiber.join(waiter)).toMatchObject({ _tag: "Failure", failure: { code: "boot_unavailable" } });
			expect(yield* boot.fence.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
			// The existing mutation acknowledgment restores the same cache without a second reader poller.
			yield* boot.append({ transaction: "tx", from: 4, to: 4, events: [] });
			expect(yield* boot.fence).toEqual({ published_through: 4 });
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
		);
	}),
);
