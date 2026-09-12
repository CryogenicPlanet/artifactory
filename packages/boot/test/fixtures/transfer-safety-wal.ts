import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { sqliteTransferSafetyCopy } from "../../src/transfer-safety-copy.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing isolated fixture directory");
if (process.argv[3] === "seed") {
	const databases = ["boot", "app"].map((name) => new Database(`${root}/${name}.db`));
	for (const database of databases) {
		database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL");
		database.exec("CREATE TABLE evidence(value TEXT)");
		database.query("INSERT INTO evidence VALUES(?)").run("committed before crash 🦋");
	}
	// Termination intentionally bypasses SQLite close/checkpoint; the parent awaits process death.
	process.kill(process.pid, "SIGKILL");
	await new Promise(() => {});
}
await Effect.runPromise(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const original = new Map<string, Uint8Array>();
		for (const name of ["boot", "app"])
			for (const suffix of ["", "-wal", "-shm"]) {
				const filename = `${root}/${name}.db${suffix}`;
				original.set(filename, yield* fs.readFile(filename));
			}
		const backup = yield* sqliteTransferSafetyCopy({
			dataDirectory: root,
			transferId: "55555555-5555-4555-8555-555555555555",
			storeId: "66666666-6666-4666-8666-666666666666",
			source: {
				boot: { _tag: "file", filename: `${root}/boot.db` },
				app: { _tag: "file", filename: `${root}/app.db` },
			},
			assertAllClosed: Effect.void, // Parent has positively awaited the sole source process exit.
		});
		const captured = yield* backup.capture;
		assert.equal(captured.receipt.files.length, 6);
		yield* fs.makeDirectory(`${root}/restored`);
		for (const file of captured.receipt.files) {
			const name = `${file.store}.db${file.suffix}`;
			yield* fs.copyFile(captured.path.replace(/receipt.json$/, name), `${root}/restored/${name}`);
		}
		for (const name of ["boot", "app"]) {
			const restored = new Database(`${root}/restored/${name}.db`);
			assert.deepEqual(restored.query("SELECT value FROM evidence").all(), [{ value: "committed before crash 🦋" }]);
			restored.close();
		}
		assert.deepEqual(yield* backup.verify(captured.path), captured.receipt);
		for (const [filename, bytes] of original) assert.deepEqual(yield* fs.readFile(filename), bytes);
		process.stdout.write("verified both committed WAL before-images\n");
	}).pipe(Effect.provide(BunServices.layer)),
);
