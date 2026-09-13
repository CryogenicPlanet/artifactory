import { it } from "@effect/vitest";
import { expect } from "vitest";
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { backupSchedule } from "../src/backup-schedule.ts";
import { BootChannel, KernelError, layer as channelLayer } from "../src/kernel/boot-channel.ts";
import { Lifecycle, layer as lifecycleLayer } from "../src/kernel/lifecycle.ts";

it.effect("requests only on live UTC hours, skips startup catchup, and survives request failure", () =>
	Effect.gen(function* () {
		yield* TestClock.setTime(30 * 60 * 1000);
		const lifecycle = yield* Lifecycle;
		const { state } = lifecycle;
		yield* Ref.set(state, "live");
		const calls = yield* Ref.make(0);
		const backup = Ref.updateAndGet(calls, (count) => count + 1).pipe(
			Effect.flatMap((count) =>
				count === 1 ? Effect.fail(new KernelError({ code: "boot_unavailable" })) : Effect.void,
			),
		);
		yield* backupSchedule.pipe(
			Effect.provide(
				Layer.merge(
					Layer.mock(BootChannel, { epoch: "test", filename: "unused.db", generation: 1, backup }),
					Layer.succeed(Lifecycle, lifecycle),
				),
			),
			Effect.forkScoped,
		);
		yield* TestClock.adjust("29 minutes");
		expect(yield* Ref.get(calls)).toBe(0);
		yield* TestClock.adjust("1 minute");
		expect(yield* Ref.get(calls)).toBe(1);
		yield* TestClock.adjust("1 hour");
		expect(yield* Ref.get(calls)).toBe(2);
		for (const inactive of ["starting", "rehearsal", "candidate", "accepted", "frozen", "draining"] as const) {
			yield* Ref.set(state, inactive);
			yield* TestClock.adjust("1 hour");
			expect(yield* Ref.get(calls)).toBe(2);
		}
		yield* Ref.set(state, "live");
		yield* TestClock.adjust("1 hour");
		expect(yield* Ref.get(calls)).toBe(3);
	}).pipe(Effect.provide(lifecycleLayer)),
);

it.effect("permits freeze during a pending request and interrupts it when the application scope closes", () =>
	Effect.gen(function* () {
		yield* TestClock.setTime(0);
		const lifecycle = yield* Lifecycle;
		const { state } = lifecycle;
		yield* Ref.set(state, "live");
		const { gate } = lifecycle;
		const entered = yield* Deferred.make<void>();
		const interrupted = yield* Ref.make(false);
		const scope = yield* Scope.fork(yield* Effect.scope);
		const backup = Deferred.succeed(entered, undefined).pipe(
			Effect.andThen(Effect.never),
			Effect.onInterrupt(() => Ref.set(interrupted, true)),
		);
		yield* backupSchedule.pipe(
			Effect.provide(
				Layer.merge(
					Layer.mock(BootChannel, { epoch: "test", filename: "unused.db", generation: 1, backup }),
					Layer.succeed(Lifecycle, lifecycle),
				),
			),
			Effect.forkIn(scope),
		);
		yield* TestClock.adjust("1 hour");
		yield* Deferred.await(entered);
		yield* gate.withPermit(Ref.set(state, "frozen"));
		expect(yield* Ref.get(interrupted)).toBe(false);
		yield* Scope.close(scope, Exit.void);
		expect(yield* Ref.get(interrupted)).toBe(true);
	}).pipe(Effect.provide(lifecycleLayer)),
);

for (const [budget, responseDelay] of [
	["30 seconds", "25 seconds"],
	["90 seconds", "95 seconds"],
] as const)
	it.effect(`allows the configured ${budget} copy budget and response framing`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const client = HttpClient.make((request, url) =>
				Effect.gen(function* () {
					expect(url.pathname).toBe("/_boot/db/backup");
					expect(request.method).toBe("POST");
					expect(request.headers["x-boot-secret"]).toBe("secret");
					yield* Deferred.succeed(entered, undefined);
					yield* Effect.sleep(responseDelay);
					return HttpClientResponse.fromWeb(request, Response.json({ id: "saved", bytes: 10 }));
				}),
			);
			yield* Effect.gen(function* () {
				const boot = yield* BootChannel;
				const request = yield* boot.backup.pipe(Effect.forkScoped);
				yield* Deferred.await(entered);
				yield* TestClock.adjust(responseDelay);
				expect(yield* Fiber.join(request)).toBeUndefined();
			}).pipe(
				Effect.provide(channelLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							WRITER_EPOCH: "epoch",
							REHEARSAL_COPY_BUDGET: budget,
							APP_STORE: "file:/unused.db",
							APP_DATABASE: "/unused.db",
							GENERATION: "1",
							STATE: "live",
							BOOT_URL: "http://localhost",
							BOOT_SECRET: "secret",
						}),
					),
				),
			);
		}),
	);

it.effect("refuses backup in rehearsal without constructing a live channel", () =>
	Effect.gen(function* () {
		const boot = yield* BootChannel;
		expect(yield* boot.backup.pipe(Effect.result)).toMatchObject({
			_tag: "Failure",
			failure: { code: "generation_not_live" },
		});
	}).pipe(
		Effect.provide(
			channelLayer.pipe(
				Layer.provide(
					Layer.succeed(
						HttpClient.HttpClient,
						HttpClient.make(() => Effect.die("Unexpected rehearsal HTTP request")),
					),
				),
			),
		),
		Effect.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					WRITER_EPOCH: "rehearsal",
					APP_STORE: "file:/unused.db",
					APP_DATABASE: "/unused.db",
					GENERATION: "1",
					STATE: "rehearsal",
					REHEARSAL_SEQUENCE: "1",
				}),
			),
		),
	),
);
