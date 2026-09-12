import { readRehearsalReport } from "./rehearsal-report.ts";
import type { ChildConfiguration } from "./keeper-configuration.ts";
import { ChildError } from "./child-error.ts";
import { startChildKeeper } from "./child-keeper-process.ts";
import { Cause, Deferred, Effect, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
export { ChildError } from "./child-error.ts";
export type Launch = typeof ChildConfiguration.Type;

/** One keeper-owned serving child, with positive exit evidence independent of boot's lifetime. */
export const launchChild = Effect.fn("launchChild")(function* (options: Launch, isolated = false) {
	const client = yield* HttpClient.HttpClient;
	const { ready, pid, stderr, handle, stop, closeScope } = yield* startChildKeeper(options, isolated);
	return yield* Effect.gen(function* () {
		const port = yield* Effect.raceFirst(
			Deferred.await(ready),
			handle.exitCode.pipe(Effect.andThen(Effect.fail(new ChildError({ code: "child_exited" })))),
		).pipe(Effect.timeout("5 seconds"));
		const processId = yield* Deferred.await(pid);
		const secret = options.env.BOOT_SECRET ?? "";
		const transition = (action: "go" | "accepted" | "live" | "frozen" | "draining") =>
			Effect.gen(function* () {
				const response = yield* client.execute(
					HttpClientRequest.post(`http://127.0.0.1:${port}/_kernel/control`).pipe(
						HttpClientRequest.setHeader("x-boot-secret", secret),
						HttpClientRequest.bodyJsonUnsafe({ action }),
					),
				);
				if (response.status !== 200) return yield* new ChildError({ code: "child_control_failed" });
				return yield* Effect.void;
			});
		const control = (action: Parameters<typeof transition>[0]) => transition(action).pipe(Effect.timeout("5 seconds"));
		const drain = transition("draining");
		const health = Effect.gen(function* () {
			// Only initialization readiness is polled. Once the DB/router is installed, one full probe owns its deadline.
			while (true) {
				const response = yield* client.execute(
					HttpClientRequest.get(`http://127.0.0.1:${port}/health`, { headers: { "x-boot-secret": secret } }),
				);
				if (
					response.status === 200 &&
					response.headers["x-comms-writer-epoch"] === options.env.WRITER_EPOCH &&
					response.headers["x-comms-kernel-protocol"] === "2"
				)
					return yield* readRehearsalReport(response).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.fail(new ChildError({ code: "health_failed" })),
						),
					);
				if (response.headers["x-comms-health-ready"] === "1") return yield* new ChildError({ code: "health_failed" });
				yield* Effect.sleep("20 millis");
			}
		});
		const ping = client
			.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/_kernel/ping`, { headers: { "x-boot-secret": secret } }))
			.pipe(
				Effect.flatMap((response) =>
					response.status === 200 &&
					response.headers["x-comms-writer-epoch"] === options.env.WRITER_EPOCH &&
					response.headers["x-comms-kernel-protocol"] === "2"
						? Effect.void
						: Effect.fail(new ChildError({ code: "child_unresponsive" })),
				),
				Effect.timeout("5 seconds"),
			);
		return {
			port,
			pid: processId,
			stderr,
			control,
			drain,
			health,
			ping,
			stop,
			exited: handle.exitCode.pipe(Effect.exit),
		};
	}).pipe(
		Effect.onError(() => closeScope),
		Effect.catchCause((cause) => {
			const reason = cause.reasons[0];
			if (cause.reasons.length !== 1 || reason?._tag !== "Fail" || !Schema.is(ChildError)(reason.error))
				return Effect.failCause(cause);
			const error = reason.error;
			return Ref.get(stderr).pipe(
				Effect.flatMap((text) => Effect.fail(new ChildError({ code: error.code, stderr: text }))),
			);
		}),
	);
});
export type RunningChild = Effect.Success<ReturnType<typeof launchChild>>;
