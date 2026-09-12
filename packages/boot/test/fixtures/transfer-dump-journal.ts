import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Redacted } from "effect";
import type { TransferSelection } from "@comms/storage/store-transfer-schema";
import { transferDumpJournal } from "../../src/transfer-dump-journal.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing isolated fixture root");
await Effect.runPromise(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const selection: TransferSelection = {
			version: 1,
			transfer_id: "11111111-1111-4111-8111-111111111111",
			data_directory: root,
			store_id: "22222222-2222-4222-8222-222222222222",
			source: { engine: "pg", endpoint: "localhost:5432", boot: "boot", app: "app" },
			target: { engine: "sqlite", endpoint: null, boot: `${root}/target-boot`, app: `${root}/target-app` },
		};
		const source = {
			boot: {
				_tag: "postgres" as const,
				database: "boot",
				url: Redacted.make("postgres://owner:secret@localhost/boot"),
			},
			app: { _tag: "postgres" as const, database: "app", url: Redacted.make("postgres://app:secret@localhost/app") },
		};
		// Fail precisely after atomic rename, before its directory durability barrier.
		const barrierDirectory = `${root}/transfers/${selection.transfer_id}/backup-resources`;
		let failBarrier = false;
		let restoredBarriers = 0;
		const faultFs: FileSystem.FileSystem = {
			...fs,
			open: (file, options) =>
				Effect.suspend(() => {
					if (file === barrierDirectory) {
						if (failBarrier) {
							failBarrier = false;
							return Effect.die("injected directory sync failure");
						}
						restoredBarriers++;
					}
					return fs.open(file, options);
				}),
		};
		const faultJournal = yield* transferDumpJournal(selection, source).pipe(
			Effect.provideService(FileSystem.FileSystem, faultFs),
		);
		failBarrier = true;
		assert.equal((yield* faultJournal.allocate("boot").pipe(Effect.exit))._tag, "Failure");
		const beforeRecovery = restoredBarriers;
		const stranded = yield* faultJournal.list;
		assert.equal(stranded.length, 1);
		assert.ok(restoredBarriers > beforeRecovery, "Same-instance recovery restores the directory barrier");
		const strandedRecord = stranded[0];
		assert.ok(strandedRecord);
		yield* faultJournal.close(strandedRecord.id);
		yield* faultJournal.finish(strandedRecord.id);
		const journal = yield* transferDumpJournal(selection, source);
		const boot = yield* journal.allocate("boot");
		const app = yield* journal.allocate("app");
		const directory = `${root}/transfers/${selection.transfer_id}/backup-resources`;
		assert.equal((yield* fs.stat(`${directory}/${boot.id}.json`)).mode & 0o777, 0o600);
		assert.deepEqual((yield* journal.list).map((record) => record.id).sort(), [boot.id, app.id].sort());
		const credential = yield* journal.credential(boot.id);
		assert.equal(new URL(Redacted.value(credential.url)).username, boot.principal);
		assert.equal(new URL(Redacted.value(credential.url)).password.length, 64);
		// Reopening from durable allocation recovers the identical credential without source SQL.
		const resumed = yield* transferDumpJournal(selection, source);
		assert.equal(Redacted.value((yield* resumed.credential(boot.id)).url), Redacted.value(credential.url));
		assert.equal((yield* resumed.finish(boot.id).pipe(Effect.result))._tag, "Failure");
		yield* resumed.ready(boot.id);
		yield* resumed.close(boot.id);
		assert.equal(yield* resumed.isFinished(boot.id), false);
		assert.equal(Redacted.value((yield* resumed.credential(boot.id)).url), Redacted.value(credential.url));
		yield* resumed.finish(boot.id);
		assert.equal(yield* resumed.isFinished(boot.id), true);
		assert.equal((yield* resumed.credential(boot.id).pipe(Effect.result))._tag, "Failure");
		assert.deepEqual(
			(yield* resumed.list).map((record) => record.id),
			[app.id],
		);
		assert.equal((yield* resumed.read(boot.id)).phase, "closed");
		// Allocation may have committed before CREATE; caller can prove absence then close directly.
		yield* resumed.close(app.id);
		yield* resumed.finish(app.id);
		const pending = `${directory}/33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.pending`;
		yield* fs.writeFileString(pending, "{interrupted secret publication", { mode: 0o600 });
		assert.deepEqual(yield* resumed.list, []);
		assert.equal(yield* fs.exists(pending), true);
		const foreign = yield* transferDumpJournal(
			{ ...selection, store_id: "55555555-5555-4555-8555-555555555555" },
			source,
		);
		assert.equal((yield* foreign.list.pipe(Effect.result))._tag, "Failure");
		const artifact = yield* resumed.pathFor(boot.id);
		yield* fs.symlink(`${root}/outside`, artifact);
		assert.equal((yield* resumed.list.pipe(Effect.result))._tag, "Failure");
		yield* fs.remove(artifact);
		const bad = yield* resumed.allocate("app");
		yield* fs.writeFileString(`${directory}/${bad.id}.json`, "{}", { mode: 0o600 });
		assert.equal((yield* resumed.list.pipe(Effect.result))._tag, "Failure");
		const linkedId = "66666666-6666-4666-8666-666666666666";
		yield* fs.makeDirectory(`${root}/outside`, { mode: 0o700 });
		yield* fs.symlink(`${root}/outside`, `${root}/transfers/${linkedId}`);
		assert.equal(
			(yield* transferDumpJournal({ ...selection, transfer_id: linkedId }, source).pipe(Effect.result))._tag,
			"Failure",
		);
		assert.deepEqual(yield* fs.readDirectory(`${root}/outside`), []);
		process.stdout.write("verified external dump journal recovery\n");
	}).pipe(Effect.provide(BunServices.layer)),
);
