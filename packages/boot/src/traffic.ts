import { Deferred, Effect, Ref, Schema } from "effect";
import type { Attempt } from "./event-http.ts";

export interface Destination extends Attempt {
	readonly port: number;
	readonly pid: number;
	readonly snapshot: string;
}
interface Gate {
	readonly frozen: boolean;
	readonly revision: number;
	readonly admitted: number;
	readonly waiting: number;
	readonly released: Deferred.Deferred<void> | null;
}
export class TrafficError extends Schema.TaggedError<TrafficError>()("TrafficError", {
	code: Schema.Literals(["freeze_queue_full"]),
}) {}

/** Admission is atomic with freeze and captures one immutable destination before body transfer. */
const admission = (route: Ref.Ref<Destination | null>) =>
	Effect.gen(function* () {
		const gate = yield* Ref.make<Gate>({ frozen: false, revision: 0, admitted: 0, waiting: 0, released: null });

		return {
			route,
			revision: Ref.get(gate).pipe(Effect.map((state) => state.revision)),
			state: Ref.get(gate).pipe(
				Effect.map((state) => ({ frozen: state.frozen, admitted: state.admitted, queued: state.waiting })),
			),
			// One total wait budget covers the 10s drain + 30s backup + 5s health cutover.
			awaitDestination: Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					let waited = false;
					while (true) {
						const wait = yield* Ref.modify(gate, (state): readonly [Deferred.Deferred<void> | "full" | null, Gate] => {
							if (!state.frozen) return [null, { ...state, admitted: state.admitted + 1 }];
							if (state.waiting >= 128) return ["full", state];
							return [state.released, { ...state, waiting: state.waiting + 1 }];
						});
						if (wait === "full") return yield* new TrafficError({ code: "freeze_queue_full" });
						if (wait) {
							waited = true;
							yield* restore(Deferred.await(wait)).pipe(
								Effect.ensuring(Ref.update(gate, (state) => ({ ...state, waiting: state.waiting - 1 }))),
							);
							continue;
						}
						yield* Effect.addFinalizer(() => Ref.update(gate, (state) => ({ ...state, admitted: state.admitted - 1 })));
						return { destination: yield* Ref.get(route), waited, revision: (yield* Ref.get(gate)).revision };
					}
				}),
			).pipe(Effect.timeout("60 seconds")),
			freeze: Effect.gen(function* () {
				if ((yield* Ref.get(gate)).frozen) return;
				const released = yield* Deferred.make<void>();
				yield* Ref.update(gate, (state) => ({ ...state, frozen: true, released, revision: state.revision + 1 }));
			}),
			drained: Effect.gen(function* () {
				while ((yield* Ref.get(gate)).admitted > 0) yield* Effect.sleep("10 millis");
			}),
			release: Effect.gen(function* () {
				const old = yield* Ref.getAndUpdate(gate, (state) => ({ ...state, frozen: false, released: null }));
				if (old.released) yield* Deferred.succeed(old.released, undefined);
			}),
		};
	});
/** The separate request gate pauses reads only for database replacement. */
export const traffic = Effect.gen(function* () {
	const route = yield* Ref.make<Destination | null>(null);
	const mutations = yield* admission(route);
	const requests = yield* admission(route);
	return { ...mutations, requests };
});
export type Traffic = Effect.Success<typeof traffic>;
