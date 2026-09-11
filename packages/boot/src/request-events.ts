import { Cause, Clock, Effect, Queue, Ref } from "effect";
import type { VerifiedIdentity } from "./enrollment.ts";
import type { EventStore } from "./event-http.ts";
import type { EventRecord } from "./events.ts";

/** Boot-scoped diagnostic writer. Request finalizers never acquire the SQL connection;
 * a blocked store can lose diagnostics, but cannot retain traffic admission. */
export const requestEvents = (store: EventStore) =>
	Effect.gen(function* () {
		const pending = yield* Queue.dropping<Omit<typeof EventRecord.Type, "seq">>(256);
		yield* Effect.gen(function* () {
			const event = yield* Queue.take(pending);
			const events = yield* Ref.get(store);
			if (!events) return yield* Effect.logError("http.request event store unavailable");
			yield* events.writeBoot(event).pipe(
				// Do not retry an uncertain commit or include request/error contents in stderr.
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					() => Effect.logError("http.request event write failed"),
				),
			);
		}).pipe(Effect.forever, Effect.forkScoped);
		return (input: {
			readonly started: bigint;
			readonly method: string;
			readonly path: string;
			readonly identity: VerifiedIdentity | null;
			readonly generation: number;
			readonly requestId: string;
		}) =>
			Effect.gen(function* () {
				let status = 503;
				yield* Effect.addFinalizer((exit) =>
					Effect.gen(function* () {
						const interrupted = exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause);
						const queued = yield* Queue.offer(pending, {
							at: yield* Clock.currentTimeMillis,
							type: "http.request",
							level: status >= 500 || exit._tag === "Failure" ? "error" : "info",
							actor: input.identity?.agent ?? "boot",
							instance: input.identity?.id ?? null,
							generation: input.generation,
							request_id: input.requestId,
							topic: null,
							message_id: null,
							payload: {
								method: input.method,
								path: input.path.slice(0, 2048),
								status,
								duration_ms: Number((yield* Clock.monotonicTimeNanos) - input.started) / 1_000_000,
								outcome: interrupted ? "interrupted" : exit._tag === "Failure" ? "failed" : "completed",
							},
						});
						if (!queued) yield* Effect.logError("http.request event queue full");
					}),
				);
				return {
					status: (value: number) =>
						Effect.sync(() => {
							status = value;
						}),
				};
			});
	});
export type RequestEvents = Effect.Success<ReturnType<typeof requestEvents>>;
