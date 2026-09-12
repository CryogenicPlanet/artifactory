import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Exit, FileSystem, Path } from "effect";
import type { TransferBinding } from "@comms/storage/store-transfer-schema";
import { writeTransferReceipt } from "../../src/store-transfer-receipt.ts";
const supplied = process.argv[2];
const mode = process.argv[3];
assert.ok(supplied && mode);
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(supplied);
	const binding: TransferBinding = {
		version: 1,
		transfer_id: "22222222-2222-4222-8222-222222222222",
		store_id: "11111111-1111-4111-8111-111111111111",
		data_directory: root,
		manifest: "a".repeat(64),
		source: { engine: "sqlite", endpoint: null, boot: path.join(root, "a"), app: path.join(root, "b") },
		target: { engine: "pg", endpoint: "localhost:5432", boot: "target_boot", app: "target_app" },
	};
	const directory = path.join(root, "transfers", binding.transfer_id);
	yield* fs.makeDirectory(directory, { recursive: true });
	const filename = path.join(directory, "journal.json");
	const pending = { binding, phase: "in_progress" } as const;
	const complete = { binding, phase: "complete" } as const;
	if (mode === "symlink") {
		yield* fs.symlink(path.join(root, "missing"), filename);
		assert.ok(Exit.isFailure(yield* writeTransferReceipt(pending).pipe(Effect.exit)));
		assert.equal(yield* fs.readLink(filename), path.join(root, "missing"));
		return `Verified ${mode}`;
	}
	assert.ok(Exit.isFailure(yield* writeTransferReceipt(complete).pipe(Effect.exit)));
	yield* writeTransferReceipt(pending);
	if (mode === "conflict") {
		assert.ok(
			Exit.isFailure(
				yield* writeTransferReceipt({ ...complete, binding: { ...binding, manifest: "b".repeat(64) } }).pipe(
					Effect.exit,
				),
			),
		);
	} else if (mode === "retry") {
		let syncs = 0;
		const failing = {
			...fs,
			open: (name: string, options?: Parameters<typeof fs.open>[1]) =>
				fs.open(name, options).pipe(
					Effect.map((file) =>
						name !== directory
							? file
							: {
									...file,
									sync: Effect.gen(function* () {
										syncs++;
										if (syncs === 1) return yield* Effect.die("injected directory sync failure after rename");
										yield* file.sync;
									}),
								},
					),
				),
		};
		assert.ok(
			Exit.isFailure(
				yield* writeTransferReceipt(complete).pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.exit),
			),
		);
		yield* writeTransferReceipt(complete).pipe(Effect.provideService(FileSystem.FileSystem, failing));
		assert.equal(syncs, 2, "Completion retry must re-prove directory durability");
	} else {
		yield* fs.writeFileString(path.join(directory, "journal.json.next"), JSON.stringify(complete));
		yield* writeTransferReceipt(pending);
		assert.ok((yield* fs.readFileString(filename)).includes('"phase":"in_progress"'));
		yield* writeTransferReceipt(complete);
		assert.ok(Exit.isFailure(yield* writeTransferReceipt(pending).pipe(Effect.exit)));
	}
	return `Verified ${mode}`;
}).pipe(Effect.provide(BunServices.layer));
BunRuntime.runMain(main.pipe(Effect.flatMap(Console.log)));
