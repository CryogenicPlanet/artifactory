import { Effect, Ref } from "effect";
import { BootChannel } from "./kernel/boot-channel.ts";
import { parseCron, runCron } from "./kernel/extension-cron.ts";
import { Lifecycle } from "./kernel/lifecycle.ts";

/** Run in the application scope: boot must freeze writers while this request is pending. */
export const backupSchedule = Effect.gen(function* () {
	const boot = yield* BootChannel;
	if (boot.store._tag !== "file") return;
	const lifecycle = yield* Lifecycle;
	return yield* runCron(parseCron("0 * * * *"), () =>
		Ref.get(lifecycle.state).pipe(
			Effect.flatMap((state) =>
				state === "live"
					? boot.backup.pipe(Effect.catch(() => Effect.logWarning("Scheduled backup failed; retrying next hour")))
					: Effect.void,
			),
		),
	);
});
