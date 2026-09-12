import { layer as durableEventsLayer } from "../../src/events.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Console, Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { AppBackup, layer as backupLayer } from "../../src/app-backup.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditLock, layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { SourceFiles, layer as sourceLayer } from "../../src/source-files.ts";

const lockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing test directory");
	const fs = yield* FileSystem.FileSystem;
	const real = yield* ChildProcessSpawner.ChildProcessSpawner;
	const availableBlocks = yield* Ref.make(5);
	const spawner = ChildProcessSpawner.make(() =>
		Effect.gen(function* () {
			const available = yield* Ref.get(availableBlocks);
			const output =
				process.platform === "linux"
					? `1024 100 ${available}\n`
					: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 100 ${100 - available} ${available} 95% /data\n`;
			return yield* real.spawn(
				ChildProcess.make("/usr/bin/printf", ["%s", output], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }),
			);
		}),
	);
	if (process.argv[3] === "backup") {
		const filename = `${root}/app.db`;
		const original = new Database(filename);
		try {
			original.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before backup')");
		} finally {
			original.close();
		}
		const backup = yield* AppBackup.pipe(
			Effect.provide(backupLayer(filename)),
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
		);
		const estimatedBytes = yield* backup.estimatedBytes;
		const refusal = yield* backup.clone(`${root}/refused.db`).pipe(Effect.result);
		const destinationExists = yield* fs.exists(`${root}/refused.db`);
		yield* Ref.set(availableBlocks, 100);
		yield* backup.clone(`${root}/saved.db`);
		const changed = new Database(filename);
		try {
			changed.exec("INSERT INTO records VALUES('after backup')");
		} finally {
			changed.close();
		}
		yield* Ref.set(availableBlocks, 0);
		yield* backup.restore(`${root}/saved.db`);
		const restored = new Database(filename);
		try {
			return {
				estimatedBytes,
				refusal,
				destinationExists,
				restored: restored.query<{ value: string }, []>("SELECT value FROM records").all(),
			};
		} finally {
			restored.close();
		}
	}
	yield* fs.makeDirectory(`${root}/app`);
	yield* fs.writeFileString(`${root}/app/main.ts`, "original");
	return yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const files = yield* SourceFiles;
			const lock = yield* EditLock;
			const sql = yield* SqlClient.SqlClient;
			const held = (yield* lock.acquire("test-family", "codex")).value;
			const owner = { id: held.id, family: held.holder_family };
			const stage = yield* files.stage(owner, "app/main.ts", new TextEncoder().encode("growth")).pipe(Effect.result);
			const pageId = yield* files.preparePages("codex", [
				{ path: "pages/new.md", content: new TextEncoder().encode("new page") },
			]);
			const page = yield* files.publish(pageId).pipe(Effect.result);
			const staging = yield* sql`SELECT path FROM staging`;
			const history = yield* sql`SELECT path FROM versions`;
			const beforeDeletion = yield* fs.readFileString(`${root}/app/main.ts`);
			yield* files.discard(pageId);
			yield* Ref.set(availableBlocks, 0);
			yield* files.stage(owner, "app/main.ts", null);
			const deletion = yield* files.prepare(owner);
			yield* files.publish(deletion);
			yield* lock.finish(owner, { succeeded: true });
			const deleted = !(yield* fs.exists(`${root}/app/main.ts`));
			yield* Ref.set(availableBlocks, 100);
			const recoveryId = yield* files.preparePages("codex", [
				{ path: "pages/recovery.md", content: new TextEncoder().encode("recovered page") },
			]);
			yield* sql`CREATE TRIGGER fail_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'fixture history failure'); END`;
			const interrupted = yield* files.publish(recoveryId).pipe(Effect.result);
			yield* sql`DROP TRIGGER fail_history`;
			yield* Ref.set(availableBlocks, 0);
			const recovered = yield* files.recover;
			const recoveredAgain = yield* files.recover;
			const recoveredContent = yield* fs.readFileString(`${root}/pages/recovery.md`);
			const pending = yield* sql`SELECT path FROM source_changes`;
			return {
				stage,
				page,
				staging,
				history,
				beforeDeletion,
				deleted,
				interrupted,
				recovered,
				recoveredAgain,
				recoveredContent,
				pending,
			};
		}).pipe(
			Effect.provide(sourceLayer(root).pipe(Layer.provideMerge(lockLayer))),
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
		);
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))),
	Effect.flatMap(Console.log),
);
main.pipe(BunRuntime.runMain);
