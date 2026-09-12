import { Cause, Console, Effect, Logger, Queue } from "effect";
import type { Events, EventRecord } from "./events.ts";

/** The synchronous logger only offers into a scoped dropping queue, never SQL. */
export const logEvents = (events: Pick<Events["Service"], "writeBoot">) =>
	Effect.gen(function* () {
		const output = yield* Console.Console;
		const pending = yield* Queue.dropping<Omit<typeof EventRecord.Type, "seq">>(256);
		yield* Effect.gen(function* () {
			const event = yield* Queue.take(pending);
			yield* events.writeBoot(event).pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					() => Effect.void,
				),
			);
		}).pipe(Effect.forever, Effect.provideService(Logger.CurrentLoggers, new Set()), Effect.forkScoped);
		const logger = Logger.make<unknown, void>((options) => {
			const level =
				options.logLevel === "Error" || options.logLevel === "Fatal"
					? "error"
					: options.logLevel === "Warn"
						? "warn"
						: options.logLevel === "Debug" || options.logLevel === "Trace"
							? "debug"
							: "info";
			const message = (Array.isArray(options.message) ? options.message : [options.message])
				.filter((value): value is string => typeof value === "string")
				.slice(0, 4)
				.join(" ")
				.slice(0, 2048)
				.replace(
					/Bearer\s+\S+|(?:cookie|authorization|secret|token|password)\s*[:=]\s*\S+|[a-f0-9]{64}/gi,
					"[redacted]",
				);
			const payload = { message, failure: options.cause.reasons.length > 0 };
			Queue.offerUnsafe(pending, {
				at: options.date.getTime(),
				type: "log",
				level,
				actor: "boot",
				instance: null,
				generation: 0,
				request_id: null,
				topic: null,
				message_id: null,
				payload,
			});
			output.error(JSON.stringify({ at: options.date.getTime(), level, ...payload }));
		});
		return new Set([logger]);
	});
