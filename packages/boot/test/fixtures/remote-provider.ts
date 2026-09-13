import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { remoteDbOps, RemoteDatabaseError } from "../../src/remote-db-ops.ts";

const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
	for (const engine of ["postgres", "mysql"] as const) {
		const operations = yield* remoteDbOps({
			store: Effect.succeed({
				_tag: engine,
				database: "app",
				url: Redacted.make(`${engine}://app:secret@invalid/app`),
			}),
			withStore: () => Effect.die("Refused operation opened app database"),
		});
		const refused = <A, E, R>(effect: Effect.Effect<A, E, R>, code: RemoteDatabaseError["code"]) =>
			Effect.gen(function* () {
				const result = yield* Effect.result(effect);
				if (
					result._tag !== "Failure" ||
					!Schema.is(RemoteDatabaseError)(result.failure) ||
					result.failure.code !== code
				)
					return yield* Effect.die(`Expected ${code}`);
				if (result.failure.message.includes("secret")) return yield* Effect.die("Leaked credential");
			});
		yield* operations.recoverCopy;
		yield* refused(operations.clone(), "provider_backup_required");
		yield* refused(operations.prepareClone(), "remote_rehearsal_unsupported");
		yield* refused(operations.rehearsal(), "remote_rehearsal_unsupported");
		yield* refused(
			operations.restoreInto({ path: "/missing", legacy_store_id: null, engine: operations.engine }),
			"provider_restore_required",
		);
		yield* refused(
			operations.restoreInto({ path: "/missing", legacy_store_id: null, engine: "sqlite" }),
			"backup_engine_mismatch",
		);
		for (const value of [
			'{"kind":"dump","phase":"allocated"}',
			'{"kind":"restore","phase":"ready"}',
			'{"kind":"dump","phase":"closed"}',
			'{"kind":"rehearsal","phase":"closed"}',
			"malformed",
		]) {
			yield* sql`INSERT INTO settings VALUES('remote_database:old',${value})`;
			yield* refused(operations.recoverCopy, "remote_database_cleanup_required");
			yield* refused(operations.recoverStaging, "remote_database_cleanup_required");
			if ((yield* sql`SELECT value FROM settings`).length !== 1) return yield* Effect.die("Legacy intent removed");
			yield* sql`DELETE FROM settings`;
		}
		yield* sql`INSERT INTO settings VALUES('remote_database:old','{"kind":"restore","phase":"closed"}')`;
		yield* operations.recoverCopy;
		yield* operations.recoverStaging;
		yield* sql`DELETE FROM settings`;
	}
	yield* Console.log("provider refusals verified");
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
