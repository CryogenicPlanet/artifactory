import { Cause, Config, Context, Deferred, Effect, Layer, Option, Ref, Semaphore } from "effect";

import { KernelError } from "./boot-channel.ts";
import { HealthProbe } from "./health-probe.ts";

export type State = "starting" | "rehearsal" | "candidate" | "accepted" | "live" | "frozen" | "draining";
const make = Effect.gen(function* () {
	const configured = yield* Config.String("STATE").pipe(Config.withDefault("starting"));
	const initial: State =
		configured === "rehearsal" ? "rehearsal" : configured === "candidate" ? "candidate" : "starting";
	const mutations = yield* Ref.make(0);
	const requests = yield* Ref.make(0);
	const changed = yield* Ref.make(yield* Deferred.make<void>());
	return {
		initial,
		state: yield* Ref.make<State>(initial),
		drained: yield* Deferred.make<void>(),
		mutations,
		requests,
		activityChanged: Effect.gen(function* () {
			const previous = yield* Ref.getAndSet(changed, yield* Deferred.make<void>());
			yield* Deferred.succeed(previous, undefined);
		}).pipe(Effect.uninterruptible),
		awaitIdle: (includeRequests: boolean) =>
			Effect.gen(function* () {
				while (true) {
					// Capture before checking counts: completion between check and await cannot be missed.
					const signal = yield* Ref.get(changed);
					if ((yield* Ref.get(mutations)) === 0 && (!includeRequests || (yield* Ref.get(requests)) === 0)) return;
					yield* Deferred.await(signal);
				}
			}),
		healthy: yield* Ref.make(false),
		gate: yield* Semaphore.make(1),
	};
});
export class Lifecycle extends Context.Service<Lifecycle, Effect.Success<typeof make>>()("comms/server/Lifecycle") {}
export const layer = Layer.effect(Lifecycle, make);

/** Standalone database tools have no lifecycle; active children stop using an uncertain connection. */
export const assertWriterHealthy = Effect.gen(function* () {
	const lifecycle = Option.getOrNull(yield* Effect.serviceOption(Lifecycle));
	if (
		lifecycle &&
		!["starting", "candidate", "rehearsal"].includes(yield* Ref.get(lifecycle.state)) &&
		!(yield* Ref.get(lifecycle.healthy))
	)
		return yield* new KernelError({ code: "boot_unavailable" });
});

/** A finalizer defect leaves the connection uncertain until its keeper proves closure. */
export const poisonUncertainWriter = (cause: Cause.Cause<unknown>) =>
	Effect.gen(function* () {
		if (cause.reasons.length > 0 && cause.reasons.every(Cause.isFailReason)) return;
		if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return;
		const lifecycle = Option.getOrNull(yield* Effect.serviceOption(Lifecycle));
		if (lifecycle) yield* Ref.set(lifecycle.healthy, false);
	});

/** A request already counted by the HTTP admission gate may finish while freeze waits for it. */
export class RequestMutation extends Context.Service<RequestMutation, Ref.Ref<boolean>>()(
	"comms/server/RequestMutation",
) {}
