import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { traffic } from "../src/traffic.ts";

it.effect(
	"restore queues reads while ordinary cutovers leave them admitted, then drains and resumes scoped requests",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* traffic;
				yield* gate.freeze;
				const before = yield* gate.requests.revision;
				const admitted = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const request = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* gate.requests.awaitDestination;
						yield* Deferred.succeed(admitted, undefined);
						yield* Deferred.await(release);
					}),
				).pipe(Effect.forkScoped);
				yield* Deferred.await(admitted);
				yield* gate.requests.freeze;
				const queued = yield* Effect.scoped(gate.requests.awaitDestination).pipe(Effect.forkScoped);
				yield* TestClock.adjust("1 millis");
				expect(yield* gate.requests.state).toEqual({ frozen: true, admitted: 1, queued: 1 });
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(request);
				yield* gate.requests.drained;
				yield* gate.requests.release;
				expect(yield* Fiber.join(queued)).toMatchObject({ waited: true, revision: before + 1 });
				expect(yield* gate.requests.state).toEqual({ frozen: false, admitted: 0, queued: 0 });
			}),
		),
);

it.effect("bounds the restore queue and releases slots after interruption and the sixty-second total deadline", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const gate = (yield* traffic).requests;
			yield* gate.freeze;
			const waiting = yield* Effect.forEach(Array.from({ length: 128 }), () =>
				Effect.scoped(gate.awaitDestination).pipe(Effect.result, Effect.forkScoped),
			);
			yield* TestClock.adjust("1 millis");
			expect(yield* gate.state).toEqual({ frozen: true, admitted: 0, queued: 128 });
			expect(yield* gate.awaitDestination.pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
				failure: { code: "freeze_queue_full" },
			});
			const first = waiting[0];
			if (!first) return yield* Effect.die("Missing queued request");
			yield* Fiber.interrupt(first);
			expect((yield* gate.state).queued).toBe(127);
			const replacement = yield* Effect.scoped(gate.awaitDestination).pipe(Effect.result, Effect.forkScoped);
			yield* TestClock.adjust("59 seconds");
			expect((yield* gate.state).queued).toBe(128);
			yield* TestClock.adjust("1 second");
			for (const pending of [...waiting.slice(1), replacement]) {
				expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure", failure: { _tag: "TimeoutError" } });
			}
			expect(yield* gate.state).toEqual({ frozen: true, admitted: 0, queued: 0 });
			yield* gate.release;
			expect(yield* Effect.scoped(gate.awaitDestination)).toMatchObject({ waited: false });
			expect(yield* gate.state).toEqual({ frozen: false, admitted: 0, queued: 0 });
		}),
	),
);

it.effect("keeps queued mutations through the full cutover budget and releases them to the destination", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const gate = yield* traffic;
			yield* gate.freeze;
			const waiting = yield* Effect.scoped(gate.awaitDestination).pipe(Effect.result, Effect.forkScoped);
			yield* TestClock.adjust("45 seconds");
			expect((yield* gate.state).queued).toBe(1);
			yield* gate.release;
			expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: "Success", success: { waited: true } });
			expect((yield* gate.state).queued).toBe(0);
		}),
	),
);
