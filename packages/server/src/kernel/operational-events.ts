import { HealthProbe } from "./health-probe.ts";
import { DateTime, Effect, Option, Ref, Schema } from "effect";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { Lifecycle } from "./lifecycle.ts";
import type { Mutate } from "./mutate.ts";
import { operationalInput } from "./idempotency.ts";

export interface OperationalEvent {
	/** Stable diagnostic key; each database attempt gets a separate reservation ID. */
	readonly transaction: string;
	readonly type: string;
	readonly level: "info" | "error";
	readonly payload: Schema.JsonObject;
	readonly actor?: string;
	readonly instance?: string;
	readonly request?: string;
}

export const recordOperationalEvent = <E = never>(
	mutate: Mutate,
	boot: BootChannel["Service"],
	input: OperationalEvent,
	change: (seq: number) => Effect.Effect<void, E> = () => Effect.void,
) =>
	Effect.gen(function* () {
		const lifecycle = yield* Lifecycle;
		const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(input.payload);
		if (
			!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.type) ||
			input.type === "topic.moved" ||
			!/^[a-f0-9]{32}$/.test(input.transaction) ||
			new TextEncoder().encode(payload).length > 65536
		)
			return yield* new KernelError({ code: "input_invalid" });
		const fields = {
			type: input.type,
			level: input.level,
			actor: input.actor ?? "system",
			instance: input.instance ?? null,
			generation: boot.generation,
			request_id: input.request ?? null,
			payload: input.payload,
		};
		return yield* mutate({
			guard: Effect.gen(function* () {
				if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return;
				if ((yield* Ref.get(lifecycle.state)) !== "live")
					return yield* new KernelError({ code: "generation_not_live" });
			}),
			idempotency: {
				instance: "",
				key: input.transaction,
				scope: "operational",
				kind: input.type,
				input: operationalInput(fields),
				outcome: Schema.fromJsonString(EventRecord),
			},
			body: (reserve) =>
				Effect.gen(function* () {
					const range = yield* reserve(1);
					const event = {
						...fields,
						seq: range.from,
						at: (yield* DateTime.nowAsDate).getTime(),
						topic: null,
						message_id: null,
					};
					yield* change(range.from);
					return { outcome: event, events: [event] };
				}),
		});
	});
