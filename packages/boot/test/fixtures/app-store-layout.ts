import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Cause, Console, Effect, FileSystem } from "effect";
import { migrateAppStore } from "../../src/app-store-layout.ts";

const root = process.argv[2];
const operation = process.argv[3];
if (!root) throw new Error("Missing directory");
if (operation === "wal") {
	const db = new Database(`${root}/comms.db`);
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT); INSERT INTO records VALUES('committed WAL')",
	);
	console.log("ready");
	await new Promise(() => {});
} else {
	const migration = Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		if (operation === "before-rename" || operation === "after-rename") {
			const injected = FileSystem.make({
				...fs,
				rename: (from, to) => {
					if (operation === "before-rename")
						return Effect.sync(() => {
							process.kill(process.pid, "SIGKILL");
						});
					return fs.rename(from, to).pipe(
						Effect.andThen(
							Effect.sync(() => {
								process.kill(process.pid, "SIGKILL");
							}),
						),
					);
				},
			});
			return yield* migrateAppStore({ dataDirectory: root, filename: `${root}/store/comms.db` }).pipe(
				Effect.provideService(FileSystem.FileSystem, injected),
			);
		}
		yield* migrateAppStore({ dataDirectory: root, filename: `${root}/store/comms.db` });
	});
	migration.pipe(
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
		Effect.provide(BunServices.layer),
		Effect.scoped,
		Effect.exit,
		Effect.flatMap((result) =>
			Console.log(
				JSON.stringify({ result: result._tag, error: result._tag === "Failure" ? Cause.pretty(result.cause) : null }),
			),
		),
		BunRuntime.runMain,
	);
}
