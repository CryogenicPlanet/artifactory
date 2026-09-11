import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { Console, Effect } from "effect";
import { AppBackup, layer } from "../../src/app-backup.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing test directory");
	const filename = `${root}/app.db`;
	const backup = yield* AppBackup.pipe(Effect.provide(layer(filename)));
	if (process.argv[3] === "restore") {
		const original = new Database(filename);
		try {
			original.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before backup')");
		} finally {
			original.close();
		}
		yield* backup.clone(`${root}/backup.db`);
		const changed = new Database(filename);
		try {
			changed.exec("PRAGMA journal_mode=WAL; INSERT INTO records VALUES('after backup')");
		} finally {
			changed.close();
		}
		// Every independently opened handle is closed before the production restore helper replaces files.
		yield* backup.restore(`${root}/backup.db`);
		const restored = new Database(filename);
		try {
			return restored.query<{ value: string }, []>("SELECT value FROM records").all();
		} finally {
			restored.close();
		}
	}
	const bootstrap = new Database(filename);
	try {
		bootstrap.exec(
			"CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT); INSERT INTO kernel_writer VALUES(1,'before'); CREATE TABLE outbox(seq INTEGER PRIMARY KEY); INSERT INTO outbox VALUES(25)",
		);
	} finally {
		bootstrap.close();
	}
	const next = yield* backup.prepareClone(filename, "rehearsal");
	const initialized = new Database(filename);
	let epoch: unknown;
	try {
		epoch = initialized.query("SELECT epoch FROM kernel_writer").get();
		initialized.exec("PRAGMA user_version=1");
	} finally {
		initialized.close();
	}
	// The same absent domain table is valid before domain initialization, and corrupt afterwards.
	const corrupt = yield* backup.prepareClone(filename, "second-probe").pipe(Effect.result);
	return { next, epoch, corrupt: corrupt._tag };
}).pipe(
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
);
main.pipe(BunRuntime.runMain);
