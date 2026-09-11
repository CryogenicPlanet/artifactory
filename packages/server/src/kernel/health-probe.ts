import { Context, Effect, Layer, Ref } from "effect";

export interface ProbeReservation {
	readonly transaction: string;
	readonly count: number;
}
const make = (allowMultiple: boolean) =>
	Effect.gen(function* () {
		return {
			allowMultiple,
			reservations: yield* Ref.make<ReadonlyArray<ProbeReservation>>([]),
			ceiling: yield* Ref.make(0),
		};
	});
/** Present only during same-fiber route health dispatch, never during router assembly. */
export class HealthProbe extends Context.Service<HealthProbe, Effect.Success<ReturnType<typeof make>>>()(
	"comms/server/HealthProbe",
) {}
export const layer = Layer.effect(HealthProbe, make(false));
export const rehearsalLayer = Layer.effect(HealthProbe, make(true));
