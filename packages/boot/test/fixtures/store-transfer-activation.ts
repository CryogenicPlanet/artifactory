import { BunRuntime, BunServices } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { bindingText, type TransferBinding } from "@comms/storage/store-transfer-schema";
import { parseDescriptor, withDatabase } from "@comms/storage/store";
import { Console, Effect, FileSystem, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { assertTransferActivation } from "../../src/store-transfer-activation.ts";
import { remoteAppStoreIdentity } from "../../src/app-store-identity.ts";
const mode = process.argv[2] ?? "complete";
BunRuntime.runMain(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "comms-activation-" }));
		const boot = yield* parseDescriptor("postgres://boot:fixture@localhost/boot");
		const binding: TransferBinding = {
			version: 1,
			transfer_id: "11111111-1111-4111-8111-111111111111",
			data_directory: directory,
			source: {
				engine: "sqlite",
				endpoint: null,
				boot: path.join(directory, "boot.db"),
				app: path.join(directory, "app.db"),
			},
			target: { engine: "pg", endpoint: "localhost:5432", boot: "boot", app: "app" },
			store_id: "22222222-2222-4222-8222-222222222222",
			manifest: "a".repeat(64),
		};
		const folder = path.join(directory, "transfers", binding.transfer_id);
		yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
		let receiptBinding = binding;
		if (mode === "manifest") receiptBinding = { ...binding, manifest: "b".repeat(64) };
		if (mode === "source")
			receiptBinding = { ...binding, source: { ...binding.source, app: path.join(directory, "other.db") } };
		if (mode === "target") receiptBinding = { ...binding, target: { ...binding.target, app: "other" } };
		if (mode === "uuid") receiptBinding = { ...binding, store_id: "33333333-3333-4333-8333-333333333333" };
		const filename = path.join(folder, "journal.json");
		if (mode !== "missing")
			yield* fs.writeFileString(
				filename,
				mode === "malformed"
					? "{"
					: JSON.stringify({ binding: receiptBinding, phase: mode === "in_progress" ? "in_progress" : "complete" }),
			);
		if (mode === "symlink") {
			yield* fs.rename(filename, path.join(folder, "other.json"));
			yield* fs.symlink(path.join(folder, "other.json"), filename);
		}
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
		if (mode !== "legacy") {
			yield* sql`INSERT INTO settings VALUES('transfer_state','complete'),('app_store_id',${binding.store_id})`;
			if (mode !== "no-journal")
				yield* sql`INSERT INTO settings VALUES('transfer_journal',${JSON.stringify({ binding, phase: mode === "sql-incomplete" ? "verified" : "complete" })})`;
		}
		if (mode === "restore") {
			const app = yield* parseDescriptor("postgres://app:fixture@localhost/app");
			if (app._tag === "file") return yield* Effect.die("remote fixture");
			yield* sql`INSERT INTO settings VALUES('app_store_initialized','1'),('app_store_database','app'),('app_store_adoption',${JSON.stringify({ store_id: binding.store_id, initialized_at: 1, engine: "postgres", database: "app", phase: "ready" })})`;
			const identity = yield* remoteAppStoreIdentity(app);
			yield* sql.withTransaction(identity.selectRestored(yield* withDatabase(app, "restored")));
			const selected = yield* identity.store;
			if (selected.database !== "restored") return yield* Effect.die("Restore pointer did not advance");
		}
		const before = yield* sql`SELECT key,value FROM settings ORDER BY key`;
		const result = yield* assertTransferActivation(
			before.map((row) => ({ key: String(row.key), value: String(row.value) })),
			{
				dataDirectory:
					mode === "directory"
						? path.dirname(directory)
						: mode === "relative"
							? path.relative(path.resolve("."), directory)
							: directory,
				boot: mode === "boot" ? yield* parseDescriptor("postgres://boot:fixture@localhost/other") : boot,
			},
		).pipe(Effect.result);
		const after = yield* sql`SELECT key,value FROM settings ORDER BY key`;
		yield* Console.log(
			JSON.stringify({
				result,
				unchanged: JSON.stringify(before) === JSON.stringify(after),
				binding: bindingText(binding).length > 0,
			}),
		);
	}).pipe(
		Effect.provide(clientLayer({ _tag: "file", filename: ":memory:" })),
		Effect.scoped,
		Effect.provide(BunServices.layer),
	),
);
