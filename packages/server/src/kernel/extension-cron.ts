import { Clock, Cron, Effect } from "effect";

/** Five-field UTC schedules; validation happens while the factory registers. */
export const parseCron = (expression: string) => {
	if (expression.trim().split(/\s+/).length !== 5)
		throw new Error("Cron requires five fields: minute hour day month weekday (UTC).");
	const schedule = Cron.parseUnsafe(expression, "UTC");
	Cron.next(schedule);
	return schedule;
};

/** Runs serially, skipping ticks missed while a previous invocation was busy. */
export const runCron = <E, R>(schedule: Cron.Cron, run: (scheduledAt: number) => Effect.Effect<void, E, R>) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const scheduledAt = Cron.next(schedule, now).getTime();
		yield* Effect.sleep(scheduledAt - now);
		yield* run(scheduledAt);
	}).pipe(Effect.forever);
