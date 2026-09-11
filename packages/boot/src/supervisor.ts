import { Cause, Crypto, Effect, FileSystem, Path, Ref, Schema, Scope, Semaphore } from "effect";
import { HttpServer } from "effect/unstable/http";
import { prepareGeneration, snapshotEntry, type ApplicationSource } from "./application.ts";
import { AppRecovery } from "./app-recovery.ts";
import { ChildAttempts } from "./child-attempts.ts";
import { ChildError, launchChild, type RunningChild } from "./child-process.ts";
import type { Attempt } from "./event-http.ts";
import { Generations, type Generation } from "./generations.ts";
import { Events } from "./events.ts";
import { traffic, type Traffic } from "./traffic.ts";
import { metrics, type BootMetrics } from "./metrics.ts";

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
	readonly metrics: BootMetrics;
}

/** Supervisor owns process recovery; the cutover coordinator shares its one operation gate. */
export const supervise = Effect.fn("supervise")(function* (options: ApplicationSource) {
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
	// A failed retirement may leave a database owner alive. Only restart receipt recovery can clear this.
	const closureUnproven = yield* Ref.make(false);
	const closing = yield* Ref.make(false);
	const assertClosure = Effect.gen(function* () {
		if (yield* Ref.get(closing)) return yield* new ChildError({ code: "boot_shutting_down" });
		if (yield* Ref.get(closureUnproven)) return yield* new ChildError({ code: "child_closure_unproven" });
	});
	const routing = yield* traffic;
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
		metrics: yield* metrics,
	} satisfies SupervisedChild;
	const redact = (text: string) => text.replace(/[a-f0-9]{64}/g, "[redacted]");
	const fail = (cause: Cause.Cause<unknown>) =>
		Ref.update(status, (state): ChildStatus => ({
			...state,
			state: "failed",
			error: redact(Cause.pretty(cause)),
			stderr: redact(state.stderr),
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
			const owner = yield* owners.reserve(generation.n);
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
			const process = yield* launchChild({
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
					BOARD_DIRECTORY: (yield* fs.exists(`${generation.snapshot_dir}.board`))
						? `${generation.snapshot_dir}.board`
						: path.join(generation.snapshot_dir ?? "", "board"),
					STATE: mode,
					...(mode === "rehearsal" ? { REHEARSAL_SEQUENCE: String(rehearsalSequence ?? 1) } : { BOOT_URL: callback }),
				},
			}).pipe(Effect.provideService(Scope.Scope, processScope));
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
				stderr: redact(yield* Ref.get(value.process.stderr)),
			});
			// Every newly activated lifetime is monitored independently of the recovery
			// operation gate, including the accepted-to-live cutover window.
			if (!alreadyWatching) yield* watch(value).pipe(Effect.catchCause(fail), Effect.forkIn(processScope));
			yield* Ref.update(tried, (values) => ({ ...values, [value.generation.n]: 0 }));
			yield* (yield* Generations).list.pipe(Effect.flatMap((rows) => Ref.set(history, rows)));
		});
	const start = (generation: Generation) =>
		Effect.gen(function* () {
			const recovery = yield* AppRecovery;
			const value = yield* launch(generation, recovery.filename, "candidate");
			const started = yield* Effect.gen(function* () {
				yield* recovery.prepare(value.attempt.epoch);
				yield* recordAttempt(value, "starting");
				yield* (yield* ChildAttempts).opened(value.id);
				yield* value.process.control("go");
				yield* value.process.health.pipe(Effect.timeout("5 seconds"));
				yield* (yield* Generations).healthy(generation.n);
				yield* activate(value);
			}).pipe(Effect.exit);
			if (started._tag === "Failure") {
				yield* retire(value);
				return yield* Effect.failCause(started.cause);
			}
			return value;
		});
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
				const stderr = Schema.is(ChildError)(result.failure) ? redact(result.failure.stderr ?? "") : "";
				yield* generations.failed(generation.n, redact(String(result.failure)), stderr, attempt);
				yield* Ref.update(status, (value) => ({ ...value, stderr }));
				yield* fail(Cause.fail(result.failure));
				yield* assertClosure;
				if (attempt < 3) yield* Effect.sleep(attempt === 1 ? "250 millis" : "500 millis");
			}
		}
		yield* generations.list.pipe(Effect.flatMap((rows) => Ref.set(history, rows)));
		yield* Ref.update(status, (value): ChildStatus => ({ ...value, state: "failed" }));
	});
	const run = Effect.gen(function* () {
		const refresh = (yield* Generations).list.pipe(
			Effect.flatMap((rows) => Ref.set(history, rows)),
			Effect.orDie,
		);
		yield* operationGate
			.withPermit(
				Effect.gen(function* () {
					if (!(yield* Ref.get(current))) yield* recover;
				}),
			)
			.pipe(Effect.ensuring(refresh), Effect.catchCause(fail));
		while (true) {
			const active = yield* Ref.get(current);
			if (!active) {
				yield* Effect.sleep("100 millis");
				continue;
			}
			yield* active.process.exited;
			yield* operationGate
				.withPermit(
					Effect.gen(function* () {
						if ((yield* Ref.get(current))?.attempt.epoch !== active.attempt.epoch) return;
						yield* Ref.set(current, null);
						yield* Ref.set(routing.route, null);
						const stderr = redact(yield* Ref.get(active.process.stderr));
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
							redact(yield* Ref.get(active.process.stderr)),
						);
						yield* Effect.sleep((yield* Ref.get(tried))[active.generation.n] === 1 ? "250 millis" : "500 millis");
						yield* recover;
					}),
				)
				.pipe(Effect.catchCause(fail));
		}
	});
	return {
		child,
		run,
		shutdown,
		fail,
		operationGate,
		current,
		assertClosure,
		launch,
		recordAttempt,
		retire,
		activate,
		start,
		callback,
	};
});
export type Supervisor = Effect.Success<ReturnType<typeof supervise>>;
