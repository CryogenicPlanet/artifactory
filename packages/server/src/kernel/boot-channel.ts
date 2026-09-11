import { EventRecord, EventPage } from "@comms/protocol/events";
import { KernelErrorCode } from "@comms/protocol/error-code";
import { Config, Context, Deferred, Effect, Layer, Redacted, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export class KernelError extends Schema.TaggedError<KernelError>()("KernelError", { code: KernelErrorCode }) {}
export interface EventQuery {
	readonly since?: number;
	readonly limit: number;
	readonly types?: ReadonlyArray<string>;
	readonly topic?: string;
	readonly agent?: string;
	readonly instance?: string;
	readonly level?: string;
	readonly requestActor?: string;
}
export const Batch = Schema.Struct({
	transaction: Schema.String,
	from: Schema.Int,
	to: Schema.Int,
	events: Schema.Array(EventRecord),
});
export type Batch = typeof Batch.Type;
const HandlerFailure = Schema.Struct({
	error: Schema.Struct({ code: Schema.Literal("handler_failed"), retriable: Schema.Literal(false) }),
});
const Range = Schema.Struct({ transaction: Schema.String, from: Schema.Int, to: Schema.Int });
const make = Effect.gen(function* () {
	const epoch = yield* Config.String("WRITER_EPOCH");
	const filename = yield* Config.String("APP_DATABASE");
	const generation = yield* Config.Int("GENERATION");
	const state = yield* Config.String("STATE").pipe(Config.withDefault("candidate"));
	if (state === "rehearsal") {
		const initial = yield* Config.Int("REHEARSAL_SEQUENCE");
		const pending = yield* Ref.make<ReadonlyArray<typeof Range.Type>>([]);
		const next = yield* Ref.make(initial);
		return {
			epoch,
			filename,
			generation,
			backup: Effect.fail(new KernelError({ code: "generation_not_live" })),
			changed: (_after: number): Effect.Effect<number, KernelError> => Effect.never,
			fence: Ref.get(next).pipe(Effect.map((value) => ({ published_through: value - 1 }))),
			reserve: (transaction: string, count: number) =>
				Effect.gen(function* () {
					const previous = (yield* Ref.get(pending)).find((item) => item.transaction === transaction);
					if (previous) {
						if (previous.to - previous.from + 1 !== count)
							return yield* new KernelError({ code: "rehearsal_reservation_conflict" });
						return previous;
					}
					const from = yield* Ref.getAndUpdate(next, (value) => value + count);
					const range = { transaction, from, to: from + count - 1 };
					yield* Ref.update(pending, (items) => [...items, range]);
					return range;
				}),
			events: (_input: EventQuery) => Effect.fail(new KernelError({ code: "rehearsal_events_forbidden" })),
			append: (_batch: Batch) => Effect.fail(new KernelError({ code: "rehearsal_append_forbidden" })),
			abort: (transaction: string) =>
				Effect.gen(function* () {
					if (!(yield* Ref.get(pending)).some((item) => item.transaction === transaction))
						return yield* new KernelError({ code: "rehearsal_reservation_conflict" });
					yield* Ref.update(pending, (items) => items.filter((item) => item.transaction !== transaction));
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
			if (response.status === 500) {
				yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HandlerFailure)));
				return yield* new KernelError({ code: "boot_handler_failed" });
			}
			if (response.status === 409 && path === "/_boot/db/backup") {
				const body = yield* response.json.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("unsafe_artifact_path") }) }),
						),
					),
				);
				return yield* new KernelError({ code: body.error.code });
			}
			if (response.status === 507) {
				const body = yield* response.json.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Struct({
								error: Schema.Struct({
									code: Schema.Literals([
										"backup_budget",
										"invalid_storage_sample",
										"storage_headroom",
										"storage_measurement_failed",
										"event_storage_over_budget",
										"event_storage_unavailable",
									]),
								}),
							}),
						),
					),
				);
				return yield* new KernelError({ code: body.error.code });
			}
			if (response.status === 400 && path.startsWith("/_boot/events?")) {
				const refusal = yield* response.json.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Struct({ error: Schema.Struct({ code: Schema.Literals(["query_invalid", "cursor_ahead"]) }) }),
						),
					),
				);
				return yield* new KernelError({ code: refusal.error.code });
			}
			if (response.status !== 200) return yield* new KernelError({ code: "boot_unavailable" });
			return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
		}).pipe(
			Effect.timeout(timeout),
			Effect.mapError((error) =>
				Schema.is(KernelError)(error) ? error : new KernelError({ code: "boot_unavailable" }),
			),
		);
	const scope = yield* Effect.scope;
	const signal = yield* Ref.make(yield* Deferred.make<void>());
	const cached = yield* Ref.make<number | null>(null);
	const unavailable = yield* Ref.make<KernelError["code"] | null>(null);
	const started = yield* Ref.make(false);
	const initialize = yield* Semaphore.make(1);
	const notify = Effect.gen(function* () {
		const next = yield* Deferred.make<void>();
		yield* Deferred.succeed(yield* Ref.getAndSet(signal, next), undefined);
	});
	const advance = (result: { readonly published_through: number }) =>
		Effect.gen(function* () {
			const previous = yield* Ref.getAndUpdate(cached, (value) => Math.max(value ?? 0, result.published_through));
			yield* Ref.set(unavailable, null);
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
				yield* Ref.set(unavailable, result.failure.code);
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
		const failure = yield* Ref.get(unavailable);
		if (failure !== null) return yield* new KernelError({ code: failure });
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
		backup: request("/_boot/db/backup", Schema.Struct({ id: Schema.String }), {}, 20_000).pipe(Effect.asVoid),
		fence,
		changed,
		events: (input: EventQuery) => {
			const params = new URLSearchParams({ limit: String(input.limit) });
			if (input.since !== undefined) params.set("since", String(input.since));
			if (input.types?.length) params.set("types", input.types.join(","));
			if (input.topic !== undefined) params.set("topic", input.topic);
			for (const field of ["agent", "instance", "level"] as const)
				if (input[field] !== undefined) params.set(field, input[field]);
			if (input.requestActor !== undefined) params.set("request_actor", input.requestActor);
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
						Effect.gen(function* () {
							if (response.status === 204) return;
							if (response.status === 500) {
								yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HandlerFailure)));
								return yield* new KernelError({ code: "boot_handler_failed" });
							}
							return yield* new KernelError({ code: "boot_unavailable" });
						}),
					),
					Effect.mapError((error) =>
						Schema.is(KernelError)(error) ? error : new KernelError({ code: "boot_unavailable" }),
					),
					Effect.asVoid,
				),
	};
});
export class BootChannel extends Context.Service<BootChannel, Effect.Success<typeof make>>()(
	"comms/server/BootChannel",
) {}
export const layer = Layer.effect(BootChannel, make);
