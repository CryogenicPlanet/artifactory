import { Cause, Crypto, DateTime, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppBackup } from "./app-backup.ts";
import { AppRecovery } from "./app-recovery.ts";
import { BackupRecord } from "./backup-metadata.ts";
import { ChildError } from "./child-process.ts";
import { Events } from "./events.ts";
import type { Supervisor } from "./supervisor.ts";

/** Exercises a disposable restored store without changing live ownership, source, or sequence state. */
export const backupDrill = Effect.fn("backupDrill")(function* (supervisor: Supervisor) {
	const sql = yield* SqlClient.SqlClient;
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const app = yield* AppRecovery;
	const backup = yield* AppBackup;
	const events = yield* Events;
	const directory = path.dirname(app.filename);
	const run = supervisor.operationGate.withPermit(
		Effect.uninterruptibleMask((interruptible) =>
			Effect.gen(function* () {
				yield* supervisor.assertClosure;
				const active = yield* Ref.get(supervisor.current);
				if (!active || (yield* sql`SELECT singleton FROM cutover`).length > 0) return null;
				const rows = yield* sql`SELECT * FROM backups ORDER BY taken_at DESC,id DESC LIMIT 1`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackupRecord))),
				);
				const saved = rows[0];
				if (!saved) return null;
				const started = (yield* DateTime.nowAsDate).getTime();
				const tested = Effect.gen(function* () {
					const expected = path.join(directory, "backups", `${saved.id}.db`);
					const canonical = path.join(yield* fs.realPath(directory), "backups", `${saved.id}.db`);
					if (
						!/^[-a-zA-Z0-9_]{1,128}$/.test(saved.id) ||
						saved.path !== expected ||
						(yield* fs.realPath(expected)) !== canonical ||
						(yield* fs.stat(expected)).type !== "File"
					)
						return yield* new ChildError({ code: "backup_path_invalid" });
					const scratch = yield* fs.makeTempDirectory({ directory, prefix: ".backup-drill-" });
					let removable = true;
					return yield* Effect.gen(function* () {
						const clone = path.join(scratch, "comms.db");
						yield* fs.copyFile(expected, clone);
						const epoch = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
						const sequence = yield* backup.prepareClone(clone, epoch);
						// A failed launch may still lack a positive child closure receipt. Keep its scratch bytes.
						removable = false;
						const child = yield* supervisor.launch(active.generation, clone, "rehearsal", sequence, epoch);
						const health = yield* interruptible(child.process.health.pipe(Effect.timeout("30 seconds"))).pipe(
							Effect.exit,
						);
						yield* supervisor.retire(child);
						removable = true;
						if (health._tag === "Failure") return yield* Effect.failCause(health.cause);
					}).pipe(
						Effect.ensuring(
							Effect.suspend(() =>
								removable ? fs.remove(scratch, { recursive: true }).pipe(Effect.orDie) : Effect.void,
							),
						),
					);
				});
				const result = yield* tested.pipe(Effect.exit);
				const completed = (yield* DateTime.nowAsDate).getTime();
				const ok = result._tag === "Success";
				yield* events.writeBoot({
					at: completed,
					type: "backup.drill",
					level: ok ? "info" : "error",
					actor: "boot",
					instance: null,
					generation: active.generation.n,
					request_id: null,
					topic: null,
					message_id: null,
					payload: { backup: saved.id, generation: active.generation.n, ok, duration_ms: completed - started },
				});
				if (result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause))
					return yield* Effect.failCause(result.cause);
				return { backup: saved.id, generation: active.generation.n, ok };
			}),
		),
	);
	return { run };
});
