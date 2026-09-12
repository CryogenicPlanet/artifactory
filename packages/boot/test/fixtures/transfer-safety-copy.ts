import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { sqliteTransferSafetyCopy } from "../../src/transfer-safety-copy.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing isolated fixture directory");
const transferId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";
for (const name of ["boot", "app"]) {
	const database = new Database(`${root}/${name}.db`);
	database.exec("CREATE TABLE evidence(value BLOB)");
	database.query("INSERT INTO evidence VALUES(?)").run(new Uint8Array([0, 255, 128, 42]));
	database.close();
}
await Effect.runPromise(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const source = {
			boot: { _tag: "file" as const, filename: `${root}/boot.db` },
			app: { _tag: "file" as const, filename: `${root}/app.db` },
		};
		const options = { dataDirectory: root, transferId, storeId, source };
		const refused = yield* sqliteTransferSafetyCopy({ ...options, assertAllClosed: Effect.fail("still-open") });
		assert.equal((yield* refused.capture.pipe(Effect.result))._tag, "Failure");
		assert.equal(yield* fs.exists(`${root}/transfers`), false);
		// More than one stream chunk, deliberately invalid: never open SQLite to 'repair' these bytes.
		const opaqueWal = new Uint8Array(256 * 1024 + 7).fill(171);
		opaqueWal.set([255, 0, 7]);
		yield* fs.writeFile(`${root}/boot.db-wal`, opaqueWal);
		const streamingFs = { ...fs, readFile: () => Effect.die("Safety copies must stream database files") };
		let checks = 0;
		const backup = yield* sqliteTransferSafetyCopy({
			...options,
			assertAllClosed: Effect.sync(() => {
				checks++;
			}),
		}).pipe(Effect.provideService(FileSystem.FileSystem, streamingFs));
		const capture = backup.capture.pipe(Effect.provideService(FileSystem.FileSystem, streamingFs));
		const verify = (filename: string) =>
			backup.verify(filename).pipe(Effect.provideService(FileSystem.FileSystem, streamingFs));
		const first = yield* capture;
		assert.equal(checks, 2);
		assert.equal(first.receipt.files.length, 3);
		assert.equal((yield* fs.stat(first.path)).mode & 0o777, 0o600);
		assert.deepEqual(yield* verify(first.path), first.receipt);
		const copied = first.path.replace(/receipt.json$/, "boot.db-wal");
		assert.deepEqual(new Uint8Array(yield* fs.readFile(copied)), opaqueWal);
		const appCopy = first.path.replace(/receipt.json$/, "app.db");
		const restored = new Database(appCopy, { readonly: true });
		assert.deepEqual(restored.query("SELECT value FROM evidence").get(), { value: new Uint8Array([0, 255, 128, 42]) });
		restored.close();
		const tampered = opaqueWal.slice();
		tampered[0] = 1;
		yield* fs.writeFile(copied, tampered);
		assert.equal((yield* verify(first.path).pipe(Effect.result))._tag, "Failure");
		const second = yield* capture;
		assert.notEqual(second.path, first.path);
		assert.equal(yield* fs.exists(first.path), true, "Failed/tampered artifacts are retained");
		assert.deepEqual(new Uint8Array(yield* fs.readFile(`${root}/boot.db-wal`)), opaqueWal);
		const foreign = yield* sqliteTransferSafetyCopy({
			...options,
			storeId: "33333333-3333-4333-8333-333333333333",
			assertAllClosed: Effect.void,
		});
		assert.equal((yield* foreign.verify(second.path).pipe(Effect.result))._tag, "Failure");
		let assertions = 0;
		const interrupted = yield* sqliteTransferSafetyCopy({
			...options,
			assertAllClosed: Effect.suspend(() => (++assertions === 1 ? Effect.void : Effect.fail("closure-lost"))),
		});
		assert.equal((yield* interrupted.capture.pipe(Effect.result))._tag, "Failure");
		const safety = `${root}/transfers/${transferId}/safety`;
		const incomplete = [];
		for (const entry of yield* fs.readDirectory(safety))
			if (!(yield* fs.exists(`${safety}/${entry}/receipt.json`))) incomplete.push(entry);
		assert.equal(incomplete.length, 1);
		const linkedId = "44444444-4444-4444-8444-444444444444";
		yield* fs.makeDirectory(`${root}/outside`);
		yield* fs.symlink(`${root}/outside`, `${root}/transfers/${linkedId}`);
		const linked = yield* sqliteTransferSafetyCopy({ ...options, transferId: linkedId, assertAllClosed: Effect.void });
		assert.equal((yield* linked.capture.pipe(Effect.result))._tag, "Failure");
		assert.deepEqual(yield* fs.readDirectory(`${root}/outside`), []);
		process.stdout.write("verified closed SQLite pair safety receipt\n");
	}).pipe(Effect.provide(BunServices.layer)),
);
