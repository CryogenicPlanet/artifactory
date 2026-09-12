import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import type { TransferPreparation } from "@comms/storage/store-transfer-schema";
import { targetDirectories } from "../../src/transfer/worker.ts";
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(process.argv[2]!);
	const preparation: TransferPreparation = {
		selection: {
			version: 1,
			transfer_id: "22222222-2222-4222-8222-222222222222",
			data_directory: root,
			source: { engine: "pg", endpoint: "localhost:5432", boot: "source_boot", app: "source_app" },
			target: {
				engine: "sqlite",
				endpoint: null,
				boot: path.join(root, "boot.db"),
				app: path.join(root, "store/comms.db"),
			},
			store_id: "33333333-3333-4333-8333-333333333333",
		},
		initialized_at: 1,
		epoch: "a".repeat(64),
		phase: "preparing",
		sentinel: "pending",
	};
	yield* targetDirectories(preparation);
	assert.equal((yield* fs.stat(path.join(root, "store"))).type, "Directory");
	assert.equal(yield* fs.exists(path.join(root, "boot.db")), false);
	yield* targetDirectories(preparation);
	const escaped = {
		...preparation,
		selection: {
			...preparation.selection,
			target: { ...preparation.selection.target, boot: path.join(root, "../escaped.db") },
		},
	};
	assert.equal((yield* Effect.exit(targetDirectories(escaped)))._tag, "Failure");
	yield* fs.writeFileString(preparation.selection.target.boot, "owned bytes");
	yield* fs.symlink(preparation.selection.target.boot, preparation.selection.target.app);
	assert.equal((yield* Effect.exit(targetDirectories(preparation)))._tag, "Failure");
	assert.equal(yield* fs.readFileString(preparation.selection.target.boot), "owned bytes");
	console.log("Target root parent and alias refusal verified");
});
BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
