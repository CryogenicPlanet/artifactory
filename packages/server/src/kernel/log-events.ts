import { Lifecycle } from "./lifecycle.ts";
import { Cause, Console, Crypto, Effect, Logger, Queue } from "effect";
import { Publication } from "./publication.ts";
import type { OperationalEvent } from "./operational-events.ts";

/** Diagnostic failure is dropped without retry or recursive logging into the outbox. */
export const logEvents = Effect.gen(function* () {
	const publication = yield* Publication;
	const lifecycle = yield* Lifecycle;
	const crypto = yield* Crypto.Crypto;
	const output = yield* Console.Console;
	const pending = yield* Queue.dropping<Omit<OperationalEvent, "transaction">>(256);
	yield* Effect.gen(function* () {
		const event = yield* Queue.take(pending);
		const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
		yield* lifecycle.gate.withPermit(publication.recordEvent({ ...event, transaction })).pipe(
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
			.replace(/Bearer\s+\S+|(?:cookie|authorization|secret|token|password)\s*[:=]\s*\S+|[a-f0-9]{64}/gi, "[redacted]");
		const payload = { message, failure: options.cause.reasons.length > 0 };
		Queue.offerUnsafe(pending, { type: "log", level, payload });
		output.error(JSON.stringify({ at: options.date.getTime(), level, ...payload }));
	});
	return logger;
});
