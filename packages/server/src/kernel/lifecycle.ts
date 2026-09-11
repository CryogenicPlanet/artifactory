import { Config, Context, Effect, Layer, Ref, Semaphore } from "effect";

export type State = "starting" | "rehearsal" | "candidate" | "accepted" | "live" | "frozen" | "draining";
const make = Effect.gen(function* () {
	const configured = yield* Config.String("STATE").pipe(Config.withDefault("starting"));
	const initial: State =
		configured === "rehearsal" ? "rehearsal" : configured === "candidate" ? "candidate" : "starting";
	return {
		initial,
		state: yield* Ref.make<State>(initial),
		mutations: yield* Ref.make(0),
		requests: yield* Ref.make(0),
		healthy: yield* Ref.make(false),
		gate: yield* Semaphore.make(1),
	};
});
export class Lifecycle extends Context.Service<Lifecycle, Effect.Success<typeof make>>()("comms/server/Lifecycle") {}
export const layer = Layer.effect(Lifecycle, make);
