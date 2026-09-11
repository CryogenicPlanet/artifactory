import { recoveryIntents } from "./recovery-intents.ts";
import { SqlClient } from "effect/unstable/sql";
import { redactHex } from "./auth-primitives.ts";
import { Cause, Config, Crypto, Effect, FileSystem, Path, Queue, Ref, Schema, Scope, Semaphore } from "effect";
import { HttpServer } from "effect/unstable/http";
import { prepareGeneration, snapshotEntry, type ApplicationSource } from "./application.ts";
import { AppRecovery } from "./app-recovery.ts";
import { ChildAttempts } from "./child-attempts.ts";
import { ChildError, launchChild, type RunningChild } from "./child-process.ts";
import type { Attempt } from "./event-http.ts";
import { Generations, type Generation } from "./generations.ts";
import { Events } from "./events.ts";
import { traffic, type Traffic } from "./traffic.ts";

export interface ChildStatus {
	readonly state: "starting" | "live" | "failed";
	readonly generation: number | null;
	readonly snapshot_dir: string | null;
	readonly attempt: number;
	readonly pid: number | null;
	readonly port: number | null;
	readonly error: string | null;
	readonly stderr: string;
}
export interface ActiveChild {
	readonly process: RunningChild;
	readonly attempt: Attempt;
	readonly generation: Generation;
	readonly id: string;
	readonly receipt: string;
}
export interface SupervisedChild {
	readonly status: Ref.Ref<ChildStatus>;
	readonly generations: Ref.Ref<readonly Generation[]>;
	readonly attempts: Ref.Ref<readonly Attempt[]>;
	readonly channelGate: Semaphore.Semaphore;
	readonly sourceError: Ref.Ref<string | null>;
	readonly traffic: Traffic;
}

/** Supervisor owns process recovery; the cutover coordinator shares its one operation gate. */
export const supervise = Effect.fn("supervise")(function* (options: ApplicationSource) {
	const isolated = yield* Config.Boolean("COMMS_ISOLATED").pipe(Config.withDefault(false));
	const crypto = yield* Crypto.Crypto;
	const path = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const processScope = yield* Scope.fork(yield* Effect.scope);
	const http = yield* HttpServer.HttpServer;
	if (http.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP boot listener");
	const callback = `http://127.0.0.1:${http.address.port}`;
	const attempts = yield* Ref.make<readonly Attempt[]>([]);
	const channelGate = yield* Semaphore.make(1);
	const operationGate = yield* Semaphore.make(1);
	const current = yield* Ref.make<ActiveChild | null>(null);
	const changed = yield* Queue.make<void>({ capacity: 1, strategy: "sliding" });
	const recoveryRequested = yield* Ref.make(false);
	const requestRecovery = Effect.gen(function* () {
		// Cleanup failure alone must not retire a healthy serving child.
		if (yield* Ref.get(current)) return;
		// A missing keeper receipt still needs explicit repair; never spin on unknown ownership.
		if ((yield* assertClosure.pipe(Effect.result))._tag === "Failure") return;
		yield* Ref.set(recoveryRequested, true);
		yield* Queue.offer(changed, undefined);
	});
	// A failed retirement may leave a database owner alive. Only restart receipt recovery can clear this.
	const closureUnproven = yield* Ref.make(false);
	const closing = yield* Ref.make(false);
	const assertClosure = Effect.gen(function* () {
		if (yield* Ref.get(closing)) return yield* new ChildError({ code: "boot_shutting_down" });
		if (yield* Ref.get(closureUnproven)) return yield* new ChildError({ code: "child_closure_unproven" });
	});
	const routing = yield* traffic;
	// Only lifecycle operations withdraw routing or reopen admission. A missing route
	// is not evidence that the authoritative store is safe to resume.
	const withdraw = Ref.set(routing.route, null).pipe(Effect.andThen(Ref.set(current, null)));
	const release = routing.requests.release.pipe(Effect.andThen(routing.release));
	const status = yield* Ref.make<ChildStatus>({
		state: "starting",
		generation: null,
		snapshot_dir: null,
		attempt: 0,
		pid: null,
		port: null,
		error: null,
		stderr: "",
	});
	const tried = yield* Ref.make<Readonly<Record<number, number>>>({});
	const history = yield* Ref.make<readonly Generation[]>([]);
	const sourceError = yield* Ref.make<string | null>(null);
	const child = {
		status,
		attempts,
		channelGate,
		sourceError,
		generations: history,
		traffic: routing,
	} satisfies SupervisedChild;
	const fail = (cause: Cause.Cause<unknown>) =>
		Ref.update(status, (state): ChildStatus => ({
			...state,
			state: "failed",
			error: redactHex(Cause.pretty(cause)),
			stderr: redactHex(state.stderr),
		}));
	const launch = (
		generation: Generation,
		filename: string,
		mode: "candidate" | "rehearsal",
		rehearsalSequence?: number,
		epochOverride?: string,
	) =>
		Effect.gen(function* () {
			yield* assertClosure;
			const owners = yield* ChildAttempts;
			const secret = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
			const epoch = epochOverride ?? Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
			const attempt: Attempt = {
				secret,
				epoch,
				host: new URL(callback).host,
				generation: generation.n,
				state: "starting",
			};
			const entry = yield* snapshotEntry(generation, options.dataDirectory);
			const board = (yield* fs.exists(`${generation.snapshot_dir}.board`))
				? `${generation.snapshot_dir}.board`
				: path.join(generation.snapshot_dir ?? "", "board");
			const owner = yield* owners.reserve(generation.n);
			const process = yield* launchChild(
				{
					entry,
					cwd: generation.snapshot_dir ?? "",
					attempt: owner.id,
					receipt: owner.receipt,
					env: {
						PORT: "0",
						BOOT_SECRET: secret,
						WRITER_EPOCH: epoch,
						GENERATION: String(generation.n),
						APP_DATABASE: filename,
						PAGES_DIRECTORY: path.resolve(options.dataDirectory, "pages"),
						BOARD_DIRECTORY: board,
						STATE: mode,
						...(mode === "rehearsal" ? { REHEARSAL_SEQUENCE: String(rehearsalSequence ?? 1) } : { BOOT_URL: callback }),
					},
				},
				isolated,
			).pipe(
				Effect.provideService(Scope.Scope, processScope),
				Effect.onError(() =>
					owners.closed(owner.id, owner.receipt).pipe(
						Effect.flatMap((closed) => (closed ? Effect.void : Ref.set(closureUnproven, true))),
						Effect.catchCause(() => Ref.set(closureUnproven, true)),
					),
				),
			);
			return { process, attempt, generation, ...owner } satisfies ActiveChild;
		});
	const recordAttempt = (value: ActiveChild, state: Attempt["state"]) =>
		channelGate.withPermit(
			Ref.update(attempts, (items) => [
				...items.filter((item) => item.epoch !== value.attempt.epoch),
				{ ...value.attempt, state },
			]),
		);
	const retire = (value: ActiveChild) =>
		Effect.gen(function* () {
			yield* channelGate.withPermit(
				Ref.update(attempts, (items) => items.filter((item) => item.epoch !== value.attempt.epoch)),
			);
			yield* value.process.stop;
			if (!(yield* (yield* ChildAttempts).closed(value.id, value.receipt)))
				return yield* new ChildError({ code: "child_closure_unproven" });
		}).pipe(Effect.onError(() => Ref.set(closureUnproven, true)));
	const shutdown = operationGate.withPermit(
		Effect.gen(function* () {
			yield* Ref.set(closing, true);
			yield* routing.requests.freeze;
			// Keep the child and its publication channel live until forwarded mutations finish.
			const mutations = yield* routing.drained.pipe(Effect.timeout("5 seconds"), Effect.exit);
			const active = yield* Ref.get(current);
			if (active) {
				const drained =
					mutations._tag === "Failure"
						? mutations
						: yield* active.process.drain.pipe(Effect.timeout("5 seconds"), Effect.exit);
				// Requests and editable shutdown hooks can hang while ping stays healthy.
				// Closure preserves the current store; startup reconciles uncertain publication.
				if (drained._tag === "Failure") {
					yield* Ref.set(routing.route, null);
					yield* retire(active);
				}
			}
			// A downstream client can stop reading even after its child has closed.
			yield* routing.requests.drained.pipe(Effect.timeout("5 seconds"), Effect.ignore);
			yield* (yield* Events).stopWaiting;
			yield* Ref.set(current, null);
			yield* Ref.set(routing.route, null);
			if (active) {
				yield* retire(active);
				yield* (yield* Generations).retired(active.generation.n);
			}
		}),
	);
	const watch = (active: ActiveChild) =>
		Effect.gen(function* () {
			while ((yield* Ref.get(current))?.attempt.epoch === active.attempt.epoch) {
				yield* Effect.sleep("1 second");
				const response = yield* active.process.ping.pipe(Effect.exit);
				if (response._tag === "Success") continue;
				if ((yield* Ref.get(current))?.attempt.epoch !== active.attempt.epoch) return;
				yield* Ref.update(routing.route, (route) => (route?.epoch === active.attempt.epoch ? null : route));
				yield* Ref.update(status, (value): ChildStatus =>
					value.pid === active.process.pid ? { ...value, state: "failed", error: "child_unresponsive" } : value,
				);
				// Never race retirement against the exit it causes: closure proof must finish.
				yield* retire(active);
				return;
			}
		});
	const activate = (value: ActiveChild, state: "accepted" | "live" = "live") =>
		Effect.gen(function* () {
			if (state === "live" && (yield* Ref.get(routing.route))?.epoch !== value.attempt.epoch) {
				yield* recordAttempt(value, "accepted");
				yield* value.process.control("accepted");
			}
			yield* recordAttempt(value, state);
			yield* value.process.control(state);
			yield* (yield* Generations).list.pipe(Effect.flatMap((rows) => Ref.set(history, rows)));
			const alreadyWatching = (yield* Ref.get(current))?.attempt.epoch === value.attempt.epoch;
			yield* Ref.set(current, value);
			yield* Ref.set(routing.route, {
				...value.attempt,
				state,
				port: value.process.port,
				pid: value.process.pid,
				snapshot: value.generation.snapshot_dir ?? "",
			});
			yield* Ref.set(status, {
				state: "live",
				generation: value.generation.n,
				snapshot_dir: value.generation.snapshot_dir,
				attempt: Math.max(1, (yield* Ref.get(tried))[value.generation.n] ?? 1),
				pid: value.process.pid,
				port: value.process.port,
				error: null,
				stderr: redactHex(yield* Ref.get(value.process.stderr)),
			});
			// Every newly activated lifetime is monitored independently of the recovery
			// operation gate, including the accepted-to-live cutover window.
			if (!alreadyWatching) yield* watch(value).pipe(Effect.catchCause(fail), Effect.forkIn(processScope));
			yield* Ref.update(tried, (values) => ({ ...values, [value.generation.n]: 0 }));
			yield* release;
			yield* Queue.offer(changed, undefined);
		});
	const start = (generation: Generation, recoverAfterFailure = false) =>
		Effect.gen(function* () {
			const recovery = yield* AppRecovery;
			const value = yield* launch(generation, recovery.filename, "candidate");
			const started = yield* Effect.gen(function* () {
				yield* recovery.prepare(value.attempt.epoch);
				if (isolated && ((yield* fs.stat(recovery.filename)).mode & 0o777) !== 0o660)
					yield* fs.chmod(recovery.filename, 0o660);
				yield* recordAttempt(value, "starting");
				yield* (yield* ChildAttempts).opened(value.id);
				yield* value.process.control("go");
				yield* value.process.health.pipe(
					Effect.timeoutOrElse({
						duration: "5 seconds",
						orElse: () => Effect.fail(new ChildError({ code: "health_failed" })),
					}),
				);
				yield* (yield* Generations).healthy(generation.n);
				yield* activate(value);
			}).pipe(Effect.exit);
			if (started._tag === "Failure") {
				yield* retire(value);
				if (recoverAfterFailure) {
					// Retirement proves this candidate closed; error tags are not closure evidence.
					yield* withdraw;
					yield* release;
				}
				return yield* Effect.failCause(started.cause);
			}
			return value;
		});
	const restart = (generation: Generation) => start(generation, true).pipe(Effect.onError(() => requestRecovery));
	const resume = (active: ActiveChild) =>
		active.process.control("live").pipe(
			Effect.catch(() => withdraw.pipe(Effect.andThen(retire(active)), Effect.andThen(restart(active.generation)))),
			Effect.andThen(release),
		);
	const recover = Effect.gen(function* () {
		const generations = yield* Generations;
		const choices = yield* prepareGeneration(options);
		for (const generation of choices) {
			if (((yield* Ref.get(tried))[generation.n] ?? 0) >= 3) continue;
			for (let attempt = ((yield* Ref.get(tried))[generation.n] ?? 0) + 1; attempt <= 3; attempt++) {
				yield* Ref.update(tried, (values) => ({ ...values, [generation.n]: attempt }));
				yield* generations.starting(generation.n);
				yield* Ref.set(status, {
					state: "starting",
					generation: generation.n,
					snapshot_dir: generation.snapshot_dir,
					attempt,
					pid: null,
					port: null,
					error: null,
					stderr: "",
				});
				const result = yield* start(generation).pipe(Effect.result);
				if (result._tag === "Success") return;
				const stderr = Schema.is(ChildError)(result.failure) ? redactHex(result.failure.stderr ?? "") : "";
				yield* generations.failed(generation.n, redactHex(String(result.failure)), stderr, attempt);
				yield* Ref.update(status, (value) => ({ ...value, stderr }));
				yield* fail(Cause.fail(result.failure));
				yield* assertClosure;
				if (attempt < 3) yield* Effect.sleep(attempt === 1 ? "250 millis" : "500 millis");
			}
		}
		yield* generations.list.pipe(Effect.flatMap((rows) => Ref.set(history, rows)));
		yield* Ref.update(status, (value): ChildStatus => ({ ...value, state: "failed" }));
	});
	const run = <E, R>(recoverAuthority: Effect.Effect<void, E, R>) =>
		Effect.gen(function* () {
			const refresh = (yield* Generations).list.pipe(
				Effect.flatMap((rows) => Ref.set(history, rows)),
				Effect.orDie,
			);
			const recoverAvailable = operationGate.withPermit(
				Effect.gen(function* () {
					const intents = yield* recoveryIntents(yield* SqlClient.SqlClient);
					if (intents.cutover || intents.restore) return yield* new ChildError({ code: "cutover_recovery_required" });
					// Source conflicts permit saved-good snapshots; withCommitted still blocks new source preparation.
					if (!(yield* Ref.get(current))) yield* recover;
				}),
			);
			yield* recoverAvailable.pipe(Effect.ensuring(refresh), Effect.catchCause(fail));
			while (true) {
				if (yield* Ref.getAndSet(recoveryRequested, false)) {
					// Root resolves source/restore journals before ordinary generation recovery.
					yield* recoverAuthority.pipe(Effect.andThen(recoverAvailable), Effect.catchCause(fail));
				}
				const active = yield* Ref.get(current);
				if (!active) {
					yield* Queue.take(changed);
					continue;
				}
				const notification = yield* Effect.raceFirst(
					active.process.exited.pipe(Effect.as("exited")),
					Queue.take(changed).pipe(Effect.as("changed")),
				);
				if (notification === "changed") continue;
				yield* operationGate
					.withPermit(
						Effect.gen(function* () {
							if ((yield* Ref.get(current))?.attempt.epoch !== active.attempt.epoch) return;
							yield* Ref.set(current, null);
							yield* Ref.set(routing.route, null);
							const stderr = redactHex(yield* Ref.get(active.process.stderr));
							const unresponsive = (yield* Ref.get(status)).error === "child_unresponsive";
							yield* Ref.update(status, (value): ChildStatus => ({
								...value,
								state: "failed",
								error: unresponsive ? "child_unresponsive" : "Child exited",
								stderr,
							}));
							yield* retire(active);
							yield* (yield* Generations).failed(
								active.generation.n,
								unresponsive ? "child_unresponsive" : "Child exited",
								redactHex(yield* Ref.get(active.process.stderr)),
							);
							yield* Effect.sleep((yield* Ref.get(tried))[active.generation.n] === 1 ? "250 millis" : "500 millis");
							yield* requestRecovery;
						}),
					)
					.pipe(
						Effect.onError(() => requestRecovery),
						Effect.catchCause(fail),
					);
			}
		});
	return {
		child,
		run,
		shutdown,
		fail,
		operationGate,
		requestRecovery,
		current,
		withdraw,
		freeze: routing.freeze,
		release,
		resume,
		restart,
		assertClosure,
		// Caller owns operationGate and has retired any current child before retrying startup.
		recoverClosure: Effect.gen(function* () {
			if (yield* Ref.get(current)) return yield* new ChildError({ code: "child_closure_unproven" });
			yield* (yield* ChildAttempts).recover;
			yield* Ref.set(closureUnproven, false);
		}),
		launch,
		recordAttempt,
		retire,
		activate,
		start,
		callback,
	};
});
export type Supervisor = Effect.Success<ReturnType<typeof supervise>>;
