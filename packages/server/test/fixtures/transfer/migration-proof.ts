import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { readMigrationProof, writeMigrationProof, type MigrationProof } from "../../../src/transfer/migration-proof.ts";
const root = process.argv[2];
const action = process.argv[3];
if (!root) throw new Error("Missing root");
const selection = {
	version: 1 as const,
	transfer_id: "12345678-1234-4234-8234-123456789abc",
	data_directory: root,
	source: { engine: "sqlite" as const, endpoint: null, boot: `${root}/boot.db`, app: `${root}/store/comms.db` },
	target: { engine: "pg" as const, endpoint: "localhost:5432", boot: "boot", app: "app" },
	store_id: "12345678-1234-4234-8234-123456789abd",
};
const proof: MigrationProof = {
	selection,
	initialized_at: 1,
	epoch: "a".repeat(64),
	generation: { n: 2, entry_file: `${root}/snapshot/server.ts`, snapshot_dir: `${root}/snapshot` },
	result: { core: [{ migration_id: 1, name: "core" }], editable: [], extensions: [], extensionProofs: [] },
	safetyReceipt: `${root}/transfers/${selection.transfer_id}/safety/12345678-1234-4234-8234-123456789abe/receipt.json`,
};
const run =
	action === "read"
		? readMigrationProof(selection)
		: writeMigrationProof(
				action === "conflict"
					? { ...proof, epoch: "b".repeat(64) }
					: action === "invalid"
						? { ...proof, safetyReceipt: `${root}/outside/receipt.json` }
						: proof,
			);
const result = await Effect.runPromise(run.pipe(Effect.result, Effect.provide(BunServices.layer)));
process.stdout.write(JSON.stringify(result));
