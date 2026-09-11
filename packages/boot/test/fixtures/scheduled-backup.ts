import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Console, Deferred, Effect, Fiber, FileSystem, Layer, Ref, Semaphore } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { AppBackup, layer as backupLayer } from "../../src/app-backup.ts";
import { AppRecovery, layer as recoveryLayer } from "../../src/app-recovery.ts";
import { layer as ownersLayer } from "../../src/child-attempts.ts";
import { ChildError } from "../../src/child-process.ts";
import { type EventRecord, Events, eventsSchema, layer as eventsLayer } from "../../src/events.ts";
import { layer as generationsLayer } from "../../src/generations.ts";
import { layer as kernelBootLayer } from "../../src/kernel-boot.ts";
import { scheduledBackup } from "../../src/scheduled-backup.ts";
import type { ActiveChild, ChildStatus, Supervisor } from "../../src/supervisor.ts";
import { traffic } from "../../src/traffic.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	const mode = process.argv[3];
	if (!root) return yield* Effect.die("Missing fixture root");
	const filename = `${root}/app.db`;
	const boot = SqliteClient.layer({ filename: `${root}/boot.db` });
	const program = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* eventsSchema;
		yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)`;
		yield* sql`CREATE TABLE cutover(singleton INTEGER PRIMARY KEY)`;
		yield* sql`CREATE TABLE backups(id TEXT PRIMARY KEY,path TEXT,reason TEXT,bytes INTEGER,taken_at INTEGER,published_through INTEGER,generation INTEGER)`;
		const events = yield* Events;
		const recovery = yield* AppRecovery;
		yield* recovery.prepare("original");
		const db = new Database(filename);
		yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
		db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT)");
		const calls: string[] = [];
		const frozen = yield* Deferred.make<void>();
		const routing = yield* traffic;
		const generation = {
			n: 1,
			snapshot_dir: "/fixture",
			entry_file: "server.ts",
			status: "live",
			good: 1,
			stderr: "",
			error: null,
			started_at: 1,
			healthy_at: 1,
			retired_at: null,
		} satisfies ActiveChild["generation"];
		const attempt = {
			epoch: "original",
			secret: "fixture",
			host: "localhost",
			generation: 1,
			state: "live",
		} satisfies ActiveChild["attempt"];
		const active: ActiveChild = {
			id: "owner",
			receipt: "fixture",
			generation,
			attempt,
			process: {
				pid: 1,
				port: 1,
				stderr: yield* Ref.make(""),
				exited: Effect.never,
				health: Effect.never,
				stop: Effect.never,
				control: (action) =>
					Effect.gen(function* () {
						calls.push(action);
						if (action === "frozen") {
							yield* Deferred.succeed(frozen, undefined);
							if (mode === "freeze-failure" || mode === "closure-failure")
								return yield* new ChildError({ code: "frozen_failed" });
						}
					}),
			},
		};
		const current = yield* Ref.make<ActiveChild | null>(active);
		const destination = { ...attempt, port: 1, pid: 1, snapshot: "/fixture" };
		yield* Ref.set(routing.route, destination);
		let closureFailed = false;
		const supervisor: Supervisor = {
			current,
			operationGate: yield* Semaphore.make(1),
			callback: "http://localhost",
			run: Effect.never,
			assertClosure: Effect.gen(function* () {
				if (closureFailed) return yield* new ChildError({ code: "child_closure_unproven" });
			}),
			fail: () => Effect.void,
			child: {
				traffic: routing,
				sourceError: yield* Ref.make<string | null>(null),
				channelGate: yield* Semaphore.make(1),
				attempts: yield* Ref.make<readonly ActiveChild["attempt"][]>([attempt]),
				generations: yield* Ref.make<readonly ActiveChild["generation"][]>([generation]),
				status: yield* Ref.make<ChildStatus>({
					state: "live",
					generation: 1,
					snapshot_dir: "/fixture",
					attempt: 1,
					pid: 1,
					port: 1,
					error: null,
					stderr: "",
				}),
			},
			launch: () => Effect.die("Unused launch"),
			admit: () => Effect.void,
			activate: () => Effect.void,
			retire: () =>
				Effect.gen(function* () {
					calls.push("retire");
					if (mode === "closure-failure") {
						closureFailed = true;
						return yield* new ChildError({ code: "child_closure_unproven" });
					}
				}),
			start: () =>
				Effect.gen(function* () {
					calls.push("restart");
					yield* recovery.prepare("restarted");
					const started = { ...active, attempt: { ...attempt, epoch: "restarted" } };
					yield* Ref.set(current, started);
					yield* Ref.set(routing.route, { ...destination, epoch: "restarted" });
					return started;
				}),
		};
		if (mode === "cutover") yield* sql`INSERT INTO cutover VALUES(1)`;
		if (mode === "registration-failure")
			yield* sql`CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN json_extract(NEW.event,'$.type')='backup.taken' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
		const backup = yield* AppBackup;
		const capture = (yield* scheduledBackup(supervisor).pipe(
			Effect.provideService(
				AppBackup,
				mode === "clone-failure" || mode === "interrupt"
					? {
							...backup,
							clone: (destination) =>
								backup
									.clone(destination)
									.pipe(
										Effect.andThen(
											mode === "interrupt" ? Effect.never : Effect.fail(new ChildError({ code: "clone_failed" })),
										),
									),
						}
					: backup,
			),
		)).capture;
		const admitted = yield* Deferred.make<void>();
		const releaseWrite = yield* Deferred.make<void>();
		const writer = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* routing.admit;
				yield* Deferred.succeed(admitted, undefined);
				yield* Deferred.await(releaseWrite);
				const batch = yield* events.reserve("write", 1, "original");
				const event = {
					seq: batch.from,
					at: 1,
					type: "message.created",
					level: "info",
					actor: "fixture",
					instance: null,
					generation: 1,
					request_id: null,
					topic: null,
					message_id: null,
					payload: {},
				} satisfies typeof EventRecord.Type;
				db.transaction(() => {
					db.exec("INSERT INTO records VALUES('acknowledged WAL write')");
					db.query("INSERT INTO mutation_batches VALUES(?,?,?,?)").run(
						"write",
						batch.from,
						batch.to,
						mode === "reconciliation-failure" ? 2 : 1,
					);
					db.query("INSERT INTO outbox VALUES(?,?,?,NULL)").run(batch.from, "write", JSON.stringify(event));
				})();
				// Deliberately leave committed outbox publication for the backup's reconciliation.
			}),
		).pipe(Effect.forkChild);
		yield* Deferred.await(admitted);
		const saving = yield* (mode === "interrupt" ? capture.pipe(Effect.timeout("100 millis")) : capture).pipe(
			Effect.exit,
			Effect.forkChild,
		);
		if (mode !== "cutover") yield* Deferred.await(frozen);
		yield* Deferred.succeed(releaseWrite, undefined);
		yield* Fiber.join(writer);
		const result = yield* Fiber.join(saving);
		const rows = yield* sql`SELECT * FROM backups`;
		const recordedEvents = yield* sql`SELECT event FROM events`;
		let saved: unknown = null;
		if (result._tag === "Success") {
			const copy = new Database(result.value.path, { readonly: true });
			try {
				saved = {
					records: copy.query("SELECT * FROM records").all(),
					epoch: copy.query("SELECT epoch FROM kernel_writer").get(),
				};
			} finally {
				copy.close();
			}
		}
		return {
			outcome: result._tag,
			files: yield* (yield* FileSystem.FileSystem)
				.readDirectory(`${root}/backups`)
				.pipe(Effect.orElseSucceed(() => [])),
			calls,
			rows,
			events: recordedEvents,
			saved,
			traffic: yield* routing.state,
			epoch: db.query("SELECT epoch FROM kernel_writer").get(),
			current: (yield* Ref.get(current))?.attempt.epoch ?? null,
		};
	});
	return yield* program.pipe(
		Effect.provide(
			Layer.mergeAll(
				recoveryLayer(filename),
				backupLayer(filename),
				ownersLayer(root).pipe(Layer.provide(kernelBootLayer)),
				generationsLayer,
			).pipe(Layer.provideMerge(eventsLayer), Layer.provideMerge(boot)),
		),
	);
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
);
main.pipe(BunRuntime.runMain);
