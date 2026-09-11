import { Context, Effect, Layer, Ref } from "effect";

export interface ProbeReservation {
	readonly transaction: string;
	readonly count: number;
}
const make = Effect.gen(function* () {
	return {
		reservation: yield* Ref.make<ProbeReservation | null>(null),
		ceiling: yield* Ref.make(0),
	};
});
/** Present only during same-fiber route health dispatch, never during router assembly. */
export class HealthProbe extends Context.Service<HealthProbe, Effect.Success<typeof make>>()(
	"comms/server/HealthProbe",
) {}
export const layer = Layer.effect(HealthProbe, make);
