import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** SQLite online copies include committed WAL pages. Call restore only after proving all owners closed. */
const make = (filename: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const sync = (name: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* (yield* fs.open(name)).sync;
				}),
			);
		return {
			clone: (destination: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`PRAGMA busy_timeout = 2000`;
						yield* sql`VACUUM INTO ${destination}`;
						yield* sync(destination);
						yield* sync(path.dirname(destination));
						return (yield* fs.stat(destination)).size;
					}).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true }))),
				),
			prepareClone: (clone: string, epoch: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`UPDATE kernel_writer SET epoch=${epoch} WHERE singleton=1`;
						const version = yield* sql`PRAGMA user_version`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ user_version: Schema.Int })))),
						);
						if (version[0]?.user_version === 0) {
							const rows = yield* sql`SELECT COALESCE(MAX(seq),0) ceiling FROM outbox`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ceiling: Schema.Int })))),
							);
							return (rows[0]?.ceiling ?? 0) + 1;
						}
						const rows =
							yield* sql`SELECT MAX(value) AS ceiling FROM (SELECT COALESCE(MAX(seq),0) value FROM messages UNION ALL SELECT COALESCE(MAX(seq),0) value FROM outbox)`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ceiling: Schema.Int })))),
							);
						return (rows[0]?.ceiling ?? 0) + 1;
					}).pipe(Effect.provide(SqliteClient.layer({ filename: clone, disableWAL: true }))),
				),
			restore: (backup: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const temporary = `${filename}.restore`;
						yield* fs.copyFile(backup, temporary);
						yield* sync(temporary);
						// The caller has positive closure evidence for every process that could own these handles.
						for (const suffix of ["-wal", "-shm"]) yield* fs.remove(`${filename}${suffix}`, { force: true });
						yield* fs.rename(temporary, filename);
						yield* sync(path.dirname(filename));
					}),
				),
		};
	});
export class AppBackup extends Context.Service<AppBackup, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/AppBackup",
) {}
export const layer = (filename: string) => Layer.effect(AppBackup, make(filename));
