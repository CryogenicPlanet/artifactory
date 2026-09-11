import { Config, Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export class KernelError extends Schema.TaggedError<KernelError>()("KernelError", { code: Schema.String }) {}
export const EventRecord = Schema.Struct({
	seq: Schema.Int,
	at: Schema.Int,
	type: Schema.String,
	level: Schema.Literals(["debug", "info", "warn", "error"]),
	actor: Schema.String,
	instance: Schema.NullOr(Schema.String),
	generation: Schema.Int,
	request_id: Schema.NullOr(Schema.String),
	topic: Schema.NullOr(Schema.String),
	message_id: Schema.NullOr(Schema.String),
	payload: Schema.Json,
});
export const EventPage = Schema.Struct({
	items: Schema.Array(EventRecord),
	cursor: Schema.Int,
	timed_out: Schema.Boolean,
	drained: Schema.Boolean,
});
export interface EventQuery {
	readonly since: number;
	readonly limit: number;
	readonly types?: ReadonlyArray<string>;
	readonly topic?: string;
}
export const Batch = Schema.Struct({
	transaction: Schema.String,
	from: Schema.Int,
	to: Schema.Int,
	events: Schema.Array(EventRecord),
});
export type Batch = typeof Batch.Type;
const AgentRoster = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			agent: Schema.String,
			kind: Schema.String,
			instance: Schema.String,
			label: Schema.String,
			created_at: Schema.Int,
			last_seen_at: Schema.NullOr(Schema.Int),
		}),
	),
});
const Range = Schema.Struct({ transaction: Schema.String, from: Schema.Int, to: Schema.Int });
const make = Effect.gen(function* () {
	const epoch = yield* Config.String("WRITER_EPOCH");
	const filename = yield* Config.String("APP_DATABASE");
	const generation = yield* Config.Int("GENERATION");
	const state = yield* Config.String("STATE").pipe(Config.withDefault("candidate"));
	if (state === "rehearsal") {
		const initial = yield* Config.Int("REHEARSAL_SEQUENCE");
		const pending = yield* Ref.make<{
			readonly transaction: string;
			readonly from: number;
			readonly to: number;
		} | null>(null);
		const next = yield* Ref.make(initial);
		return {
			agents: Effect.fail(new KernelError({ code: "rehearsal_identity_forbidden" })),
			epoch,
			filename,
			generation,
			fence: Ref.get(next).pipe(Effect.map((value) => ({ published_through: value - 1 }))),
			reserve: (transaction: string, count: number) =>
				Effect.gen(function* () {
					const previous = yield* Ref.get(pending);
					if (previous) {
						if (previous.transaction !== transaction || previous.to - previous.from + 1 !== count)
							return yield* new KernelError({ code: "rehearsal_reservation_conflict" });
						return previous;
					}
					const from = yield* Ref.getAndUpdate(next, (value) => value + count);
					const range = { transaction, from, to: from + count - 1 };
					yield* Ref.set(pending, range);
					return range;
				}),
			events: (_input: EventQuery) => Effect.fail(new KernelError({ code: "rehearsal_events_forbidden" })),
			append: (_batch: Batch) => Effect.fail(new KernelError({ code: "rehearsal_append_forbidden" })),
			abort: (transaction: string) =>
				Effect.gen(function* () {
					if ((yield* Ref.get(pending))?.transaction !== transaction)
						return yield* new KernelError({ code: "rehearsal_reservation_conflict" });
					yield* Ref.set(pending, null);
				}),
		};
	}
	const url = yield* Config.String("BOOT_URL");
	const secret = yield* Config.Redacted("BOOT_SECRET");
	const client = yield* HttpClient.HttpClient;
	const request = <S extends Schema.Constraint>(path: string, schema: S, payload?: Schema.Json) =>
		Effect.gen(function* () {
			let request =
				payload === undefined
					? HttpClientRequest.get(`${url}${path}`)
					: HttpClientRequest.post(`${url}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(payload));
			request = request.pipe(HttpClientRequest.setHeader("x-boot-secret", Redacted.value(secret)));
			const response = yield* client.execute(request);
			if (response.status !== 200) return yield* new KernelError({ code: "boot_unavailable" });
			return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
		}).pipe(
			Effect.timeout("1500 millis"),
			Effect.mapError(() => new KernelError({ code: "boot_unavailable" })),
		);
	return {
		agents: request("/_boot/agents", AgentRoster),
		epoch,
		filename,
		generation,
		fence: request("/_boot/seq", Schema.Struct({ published_through: Schema.Int })),
		events: (input: EventQuery) => {
			const params = new URLSearchParams({ since: String(input.since), limit: String(input.limit) });
			if (input.types?.length) params.set("types", input.types.join(","));
			if (input.topic !== undefined) params.set("topic", input.topic);
			return request(`/_boot/events?${params}`, EventPage);
		},
		reserve: (transaction: string, count: number) => request("/_boot/seq/reserve", Range, { transaction, count }),
		append: (batch: Batch) => request("/_boot/events/append", Schema.Struct({ published_through: Schema.Int }), batch),
		abort: (transaction: string) =>
			client
				.execute(
					HttpClientRequest.post(`${url}/_boot/seq/abort`).pipe(
						HttpClientRequest.setHeader("x-boot-secret", Redacted.value(secret)),
						HttpClientRequest.bodyJsonUnsafe({ transaction }),
					),
				)
				.pipe(
					Effect.timeout("1500 millis"),
					Effect.flatMap((response) =>
						response.status === 204 ? Effect.void : Effect.fail(new KernelError({ code: "boot_unavailable" })),
					),
					Effect.mapError(() => new KernelError({ code: "boot_unavailable" })),
				),
	};
});
export class BootChannel extends Context.Service<BootChannel, Effect.Success<typeof make>>()(
	"comms/server/BootChannel",
) {}
export const layer = Layer.effect(BootChannel, make);
