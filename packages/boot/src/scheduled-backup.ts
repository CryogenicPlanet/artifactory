import { Crypto, DateTime, Effect, FileSystem, Path, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppBackup } from "./app-backup.ts";
import { AppRecovery } from "./app-recovery.ts";
import type { ChildAttempts } from "./child-attempts.ts";
import { ChildError } from "./child-process.ts";
import { Events } from "./events.ts";
import type { Generations } from "./generations.ts";
import type { Supervisor } from "./supervisor.ts";

/** A scheduled copy shares the writer drain boundary without changing the live writer epoch. */
export const scheduledBackup = Effect.fn("scheduledBackup")(function* (supervisor: Supervisor) {
	const sql = yield* SqlClient.SqlClient;
	const recovery = yield* AppRecovery;
	const backup = yield* AppBackup;
	const events = yield* Events;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const context = yield* Effect.context<Generations | AppRecovery | ChildAttempts>();
	const capture = supervisor.operationGate.withPermit(
		Effect.gen(function* () {
			yield* supervisor.assertClosure;
			if ((yield* sql`SELECT singleton FROM cutover`).length > 0)
				return yield* new ChildError({ code: "cutover_recovery_required" });
			const active = yield* Ref.get(supervisor.current);
			const route = yield* Ref.get(supervisor.child.traffic.route);
			if (
				!active ||
				route?.epoch !== active.attempt.epoch ||
				route.state !== "live" ||
				(yield* supervisor.child.traffic.state).frozen
			)
				return yield* new ChildError({ code: "backup_live_child_required" });
			let closed = false;
			let canResume = false;
			let created: string | null = null;
			const retire = Effect.gen(function* () {
				yield* Ref.set(supervisor.current, null);
				yield* Ref.set(supervisor.child.traffic.route, null);
				if (!closed) {
					yield* supervisor.retire(active).pipe(Effect.provideContext(context));
					closed = true;
				}
			});
			const restart = Effect.gen(function* () {
				yield* retire;
				// start reconciles the authoritative store, never a saved database.
				yield* supervisor.start(active.generation).pipe(Effect.provideContext(context));
			});
			yield* supervisor.child.traffic.freeze;
			const result = yield* Effect.gen(function* () {
				const frozen = yield* active.process.control("frozen").pipe(Effect.exit);
				if (frozen._tag === "Failure") yield* retire;
				else canResume = true;
				yield* supervisor.child.traffic.drained.pipe(Effect.timeout("5 seconds"));
				canResume = false;
				yield* recovery.prepare(active.attempt.epoch);
				canResume = !closed;
				const published = (yield* events.state).published_through;
				const id = yield* crypto.randomUUIDv4;
				const directory = path.join(path.dirname(recovery.filename), "backups");
				yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
				const saved = path.join(directory, `${id}.db`);
				created = saved;
				const bytes = Number(yield* backup.clone(saved));
				const taken = (yield* DateTime.nowAsDate).getTime();
				const record = {
					id,
					path: saved,
					reason: "hourly",
					bytes,
					taken_at: taken,
					published_through: published,
					generation: active.generation.n,
				};
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation)
						VALUES(${id},${saved},'hourly',${bytes},${taken},${published},${active.generation.n})`;
						yield* events.writeBoot({
							at: taken,
							type: "backup.taken",
							level: "info",
							actor: "boot",
							instance: null,
							generation: active.generation.n,
							request_id: null,
							topic: null,
							message_id: null,
							payload: { id, reason: "hourly", bytes, published_through: published },
						});
					}),
				);
				return record;
			}).pipe(Effect.timeout("10 seconds"), Effect.interruptible, Effect.exit);
			// Cancellation and failed controls are not lifecycle acknowledgements. Restoration must
			// finish before the gate is released; an unproven closure deliberately leaves traffic frozen.
			yield* supervisor.assertClosure;
			yield* canResume ? active.process.control("live").pipe(Effect.catch(() => restart)) : restart;
			yield* supervisor.child.traffic.release;
			if (result._tag === "Failure") {
				// A failed commit response may still have registered the file. Only remove an
				// uncataloged copy; failed cleanup is logged and must not refreeze a healthy child.
				yield* Effect.gen(function* () {
					if (created && (yield* sql`SELECT id FROM backups WHERE path=${created}`).length === 0)
						yield* fs.remove(created, { force: true });
				}).pipe(Effect.catchCause(Effect.logError));
				return yield* Effect.failCause(result.cause);
			}
			return result.value;
		}).pipe(Effect.uninterruptible),
	);
	return { capture };
});
