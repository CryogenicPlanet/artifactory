import { Cause, Console, Deferred, Effect, Logger } from "effect";
import { expect, it } from "vitest";
import { logEvents } from "../src/log-events.ts";
import type { Events, EventRecord } from "../src/events.ts";

it("drops overflow and failed diagnostic writes without recursion, retaining bounded sanitized NDJSON", async () => {
	const output: string[] = [],
		written: Array<Omit<typeof EventRecord.Type, "seq">> = [];
	await Effect.runPromise(
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			const entered = yield* Deferred.make<void>();
			const writeBoot: Events["Service"]["writeBoot"] = (event) =>
				Effect.gen(function* () {
					written.push(event);
					yield* Deferred.succeed(entered, undefined);
					yield* Deferred.await(release);
					yield* Effect.logError("must-not-recurse");
					return yield* Effect.failCause(Cause.die("private-store-error"));
				});
			const loggers = yield* logEvents({ writeBoot });
			yield* Effect.logWarning("authorization=private-token", { private: "hidden" }).pipe(
				Effect.provideService(Logger.CurrentLoggers, loggers),
			);
			yield* Deferred.await(entered);
			for (let n = 0; n < 300; n++)
				yield* Effect.logInfo("bounded").pipe(Effect.provideService(Logger.CurrentLoggers, loggers));
			expect(written).toHaveLength(1);
			yield* Deferred.succeed(release, undefined);
			while (written.length < 257) yield* Effect.yieldNow;
			expect(written).toHaveLength(257);
		}).pipe(
			Effect.scoped,
			Effect.provideService(Console.Console, {
				...console,
				error: (...values: ReadonlyArray<unknown>) => output.push(values.map(String).join(" ")),
			}),
		),
	);
	expect(written[0]).toMatchObject({ type: "log", level: "warn", payload: { message: "[redacted]" } });
	expect(output).toHaveLength(301);
	for (const line of output) expect(() => JSON.parse(line)).not.toThrow();
	expect(output.join("")).not.toMatch(/private-token|hidden|must-not-recurse|private-store-error/);
});
