import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { traffic } from "../src/traffic.ts";
it("maintenance rejects new reads and waits for the admitted scope without freezing ordinary cutover reads", async () => {
	const result = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* traffic;
				yield* gate.freeze;
				const before = yield* gate.requests.revision;
				const admitted = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const request = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* gate.requests.admit;
						yield* Deferred.succeed(admitted, undefined);
						yield* Deferred.await(release);
					}),
				).pipe(Effect.forkScoped);
				yield* Deferred.await(admitted);
				yield* gate.requests.freeze;
				const paused = yield* gate.requests.admit.pipe(Effect.result);
				const state = yield* gate.requests.state;
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(request);
				yield* gate.requests.drained;
				yield* gate.requests.release;
				const next = yield* gate.requests.admit;
				return { paused, state, before, after: next.revision };
			}),
		),
	);
	expect(result.paused).toMatchObject({ _tag: "Failure", failure: { code: "freeze_queue_full" } });
	expect(result.state).toEqual({ frozen: true, admitted: 1, queued: 0 });
	expect(result.after).toBe(result.before + 1);
});
