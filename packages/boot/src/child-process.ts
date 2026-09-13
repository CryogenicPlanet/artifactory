import { readRehearsalReport } from "./rehearsal-report.ts";
import { ChildConfiguration } from "./keeper-configuration.ts";
import { logRedactor } from "./log-redaction.ts";
import { Cause, Deferred, Effect, Exit, FileSystem, Path, Ref, Schema, Scope, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class ChildError extends Schema.TaggedError<ChildError>()("ChildError", {
	code: Schema.Literals([
		"accepted_snapshot_missing",
		"rehearsal_copy_timeout",
		"sqlite_copy_failed",
		"sqlite_copy_invalid",
		"sqlite_copy_closure_unproven",
		"backup_live_child_required",
		"boot_shutting_down",
		"child_closure_unproven",
		"child_control_failed",
		"child_exited",
		"child_receipt_invalid",
		"child_unresponsive",
		"cutover_backup_invalid",
		"cutover_backup_missing",
		"cutover_recovery_required",
		"remote_cutover_requires_operator",
		"generation_store_incompatible",
		"health_failed",
		"incompatible_schema",
		"keeper_closure_unproven",
		"preparation_build_failed",
		"preparation_build_timeout",
		"preparation_group_closure_unproven",
		"preparation_group_probe_failed",
		"preparation_install_failed",
		"preparation_install_timeout",
		"restore_backup_changed",
		"restore_backup_invalid",
		"backup_engine_mismatch",
		"restore_record_missing",
		"restore_recovery_required",
		"restore_rehearsal_failed",
		"restore_safety_backup_missing",
		"restore_snapshot_missing",
	]),
	stderr: Schema.optionalKey(Schema.String),
}) {
	get message() {
		return this.code === "remote_cutover_requires_operator"
			? "Remote candidate may have changed the database. Automatic data rollback is unavailable; inspect the failed migration and use your provider restore or a forward repair before restarting chirp."
			: `Child operation failed: ${this.code}`;
	}
}
export type Launch = typeof ChildConfiguration.Type;

/** One keeper-owned process lifetime, with positive exit evidence independent of boot's lifetime. */
export const launchChild = Effect.fn("launchChild")(function* (options: Launch, isolated = false) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const client = yield* HttpClient.HttpClient;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const entry = yield* path.fromFileUrl(new URL(`./child-keeper.${extension}`, import.meta.url));
	const scope = yield* Scope.fork(yield* Effect.scope);
	const stderr = yield* Ref.make("");
	const redact = logRedactor([options.env.APP_STORE ?? "", options.env.BOOT_SECRET ?? ""]);
	return yield* Effect.gen(function* () {
		const configuration = yield* Schema.encodeEffect(Schema.fromJsonString(ChildConfiguration))(options);
		const handle = yield* spawner
			.spawn(
				ChildProcess.make(
					isolated ? "/usr/bin/sudo" : process.execPath,
					isolated ? ["-n", "/opt/comms/deployment/child-keeper"] : [entry],
					{
						env: { COMMS_CHILD_CONFIG: configuration },
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
						forceKillAfter: "5 seconds",
					},
				),
			)
			.pipe(Effect.provideService(Scope.Scope, scope));
		if (isolated)
			yield* Effect.addFinalizer(() =>
				handle.isRunning.pipe(
					Effect.flatMap((running) =>
						running
							? Stream.run(Stream.empty, handle.stdin).pipe(Effect.interruptible, Effect.timeout("1 second"))
							: Effect.void,
					),
					Effect.ignore,
				),
			).pipe(Effect.provideService(Scope.Scope, scope));
		const ready = yield* Deferred.make<number>();
		const pid = yield* Deferred.make<number>();
		let pending = "";
		yield* handle.stdout.pipe(
			Stream.decodeText(),
			Stream.runForEach((chunk) =>
				Effect.gen(function* () {
					const text = pending + chunk;
					pending = text.slice(-128);
					const port = /(?:^|\n)COMMS_CHILD_PORT=(\d{1,5})\n/.exec(text)?.[1];
					const processId = /(?:^|\n)COMMS_CHILD_PID=(\d+)\n/.exec(text)?.[1];
					if (port && Number(port) > 0 && Number(port) <= 65535) yield* Deferred.succeed(ready, Number(port));
					if (processId) yield* Deferred.succeed(pid, Number(processId));
				}),
			),
			Effect.forkIn(scope),
		);
		let errorLine = "";
		let oversized = false;
		const retain = (text: string) => Ref.update(stderr, (prior) => (prior + redact(text)).slice(-8192));
		yield* handle.stderr.pipe(
			Stream.decodeText(),
			Stream.runForEach((chunk) =>
				Effect.gen(function* () {
					for (const [index, part] of chunk.split("\n").entries()) {
						if (index > 0) {
							yield* retain(oversized ? "[diagnostic line too long]\n" : `${errorLine}\n`);
							errorLine = "";
							oversized = false;
						}
						if (oversized) continue;
						if (errorLine.length + part.length > 65536) {
							errorLine = "";
							oversized = true;
						} else errorLine += part;
					}
				}),
			),
			Effect.andThen(Effect.suspend(() => retain(oversized ? "[diagnostic line too long]" : errorLine))),
			Effect.forkIn(scope),
		);
		// Ownership preparation copies/seals files before editable code exists. Its
		// bounded I/O phase must not consume the child's five-second readiness budget.
		if (isolated)
			yield* Effect.raceFirst(
				Deferred.await(pid),
				handle.exitCode.pipe(Effect.andThen(Effect.fail(new ChildError({ code: "child_exited" })))),
			).pipe(Effect.timeout("60 seconds"));
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
		// A watchdog and a cutover may close the same lifetime concurrently. Cache the
		// complete closure result; neither a caller interruption nor a retry skips proof.
		const stop = yield* Effect.cached(
			Effect.gen(function* () {
				yield* Scope.close(scope, Exit.void);
				yield* handle.exitCode.pipe(
					Effect.timeout("5 seconds"),
					Effect.mapError(() => new ChildError({ code: "keeper_closure_unproven" })),
				);
				if (yield* handle.isRunning) return yield* new ChildError({ code: "keeper_closure_unproven" });
				// Remote SQL exclusion is enforced when the next writing session acquires its lock.
				if (options.env.APP_STORE !== undefined && options.env.APP_DATABASE === undefined) return;
				const receipt = yield* fs
					.readFileString(options.receipt)
					.pipe(Effect.mapError(() => new ChildError({ code: "child_closure_unproven" })));
				if (receipt !== options.attempt) return yield* new ChildError({ code: "child_closure_unproven" });
			}).pipe(Effect.uninterruptible),
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
		Effect.onError(() => Scope.close(scope, Exit.void)),
		Effect.catchCause((cause) => {
			const reason = cause.reasons[0];
			if (cause.reasons.length !== 1 || reason?._tag !== "Fail" || !Schema.is(ChildError)(reason.error))
				return Effect.failCause(cause);
			const error = reason.error;
			return Effect.gen(function* () {
				return yield* new ChildError({
					code: error.code,
					stderr: yield* Ref.get(stderr),
				});
			});
		}),
	);
});
export type RunningChild = Effect.Success<ReturnType<typeof launchChild>>;
