import { Config, Context, Deferred, Effect, Layer, Redacted, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const KernelErrorCode = Schema.Literals([
	"app_schema_unsupported",
	"author_required",
	"batch_missing",
	"boot_unavailable",
	"cursor_ahead",
	"event_cursor_invalid",
	"extension_migration_conflict",
	"extension_migration_invalid",
	"generation_not_live",
	"health_context_invalid",
	"health_create_invalid",
	"health_failed",
	"health_read_invalid",
	"health_response_too_large",
	"health_route_failed",
	"idempotency_conflict",
	"idempotency_migration_invalid",
	"input_invalid",
	"message_not_found",
	"query_invalid",
	"public_pages_limit",
	"rehearsal_append_forbidden",
	"rehearsal_events_forbidden",
	"rehearsal_reservation_conflict",
	"scope_required",
	"sql_unsupported",
	"stale_writer",
	"topic_archived",
	"topic_exists",
	"topic_not_found",
	"unsupported_media_type",
	"webhook_response_too_large",
]);
export class KernelError extends Schema.TaggedError<KernelError>()("KernelError", { code: KernelErrorCode }) {}
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
			epoch,
			filename,
			generation,
			changed: (_after: number): Effect.Effect<number, KernelError> => Effect.never,
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
	const request = <S extends Schema.Constraint>(path: string, schema: S, payload?: Schema.Json, timeout = 1500) =>
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
			Effect.timeout(timeout),
			Effect.mapError(() => new KernelError({ code: "boot_unavailable" })),
		);
	const scope = yield* Effect.scope;
	const signal = yield* Ref.make(yield* Deferred.make<void>());
	const cached = yield* Ref.make<number | null>(null);
	const available = yield* Ref.make(true);
	const started = yield* Ref.make(false);
	const initialize = yield* Semaphore.make(1);
	const notify = Effect.gen(function* () {
		const next = yield* Deferred.make<void>();
		yield* Deferred.succeed(yield* Ref.getAndSet(signal, next), undefined);
	});
	const advance = (result: { readonly published_through: number }) =>
		Effect.gen(function* () {
			const previous = yield* Ref.getAndUpdate(cached, (value) => Math.max(value ?? 0, result.published_through));
			yield* Ref.set(available, true);
			if (previous === null || result.published_through > previous) yield* notify;
		}).pipe(Effect.uninterruptible);
	const fenceSchema = Schema.Struct({ published_through: Schema.Int });
	const follow = Effect.gen(function* () {
		while (true) {
			const after = yield* Ref.get(cached);
			if (after === null) return;
			const result = yield* request(`/_boot/seq?since=${after}&wait=60`, fenceSchema, undefined, 65_000).pipe(
				Effect.result,
			);
			if (result._tag === "Success") yield* advance(result.success);
			else {
				yield* Ref.set(available, false);
				yield* notify;
				// Only failed channel requests retry on a timer; healthy idle readers share one boot wait.
				yield* Effect.sleep("1 second");
			}
		}
	});
	const fence = Effect.gen(function* () {
		if (!(yield* Ref.get(started)))
			yield* initialize.withPermit(
				Effect.gen(function* () {
					if ((yield* Ref.get(cached)) === null) yield* request("/_boot/seq", fenceSchema).pipe(Effect.tap(advance));
					yield* Effect.gen(function* () {
						if (!(yield* Ref.getAndSet(started, true))) yield* follow.pipe(Effect.forkIn(scope));
					}).pipe(Effect.uninterruptible);
				}),
			);
		if (!(yield* Ref.get(available))) return yield* new KernelError({ code: "boot_unavailable" });
		const value = yield* Ref.get(cached);
		if (value === null) return yield* new KernelError({ code: "boot_unavailable" });
		return { published_through: value };
	});
	const changed = (after: number) =>
		Effect.gen(function* () {
			while (true) {
				const pending = yield* Ref.get(signal);
				const current = (yield* fence).published_through;
				if (current > after) return current;
				yield* Deferred.await(pending);
			}
		});
	return {
		epoch,
		filename,
		generation,
		fence,
		changed,
		events: (input: EventQuery) => {
			const params = new URLSearchParams({ since: String(input.since), limit: String(input.limit) });
			if (input.types?.length) params.set("types", input.types.join(","));
			if (input.topic !== undefined) params.set("topic", input.topic);
			return request(`/_boot/events?${params}`, EventPage);
		},
		reserve: (transaction: string, count: number) => request("/_boot/seq/reserve", Range, { transaction, count }),
		append: (batch: Batch) => request("/_boot/events/append", fenceSchema, batch).pipe(Effect.tap(advance)),
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
