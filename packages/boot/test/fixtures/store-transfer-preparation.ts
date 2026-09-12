import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path } from "effect";
import { parseDescriptor } from "@comms/storage/store";
import { readTransferAdmission } from "../../src/store-transfer-preparation.ts";
import { assertTransferActivation } from "../../src/store-transfer-activation.ts";
const mode = process.argv[2] ?? "pending";
BunRuntime.runMain(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "comms-preparing-" }));
		const selected = { _tag: "file" as const, filename: path.join(directory, "boot.db") };
		const selection = {
			version: 1 as const,
			transfer_id: "11111111-1111-4111-8111-111111111111",
			data_directory: directory,
			source: { engine: "pg" as const, endpoint: "localhost:5432", boot: "source_boot", app: "source_app" },
			target: {
				engine: "sqlite" as const,
				endpoint: null,
				boot: selected.filename,
				app: path.join(directory, "app.db"),
			},
			store_id: "22222222-2222-4222-8222-222222222222",
		};
		const binding = { ...selection, manifest: "a".repeat(64) };
		const parent = path.join(directory, "transfers");
		const folder = path.join(parent, selection.transfer_id);
		if (mode !== "legacy" && mode !== "sql-in-progress") {
			yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
			const journal = ["complete", "missing-sql", "missing-boot", "history"].includes(mode)
				? { binding, phase: "complete" }
				: mode === "in_progress"
					? { binding, phase: "in_progress" }
					: {
							selection,
							initialized_at: 1,
							epoch: "b".repeat(64),
							phase: "preparing",
							sentinel: mode === "ready" ? "ready" : "pending",
						};
			if (mode !== "empty" && mode !== "next")
				yield* fs.writeFileString(
					path.join(folder, "journal.json"),
					mode === "malformed" ? "{" : JSON.stringify(journal),
				);
			if (["complete", "missing-sql", "history"].includes(mode))
				yield* fs.writeFileString(selected.filename, "closed boot bytes");
			if (mode === "history") {
				const other = "33333333-3333-4333-8333-333333333333";
				yield* fs.makeDirectory(path.join(parent, other));
				yield* fs.writeFileString(
					path.join(parent, other, "journal.json"),
					JSON.stringify({ binding: { ...binding, transfer_id: other }, phase: "complete" }),
				);
			}
			if (mode === "next") {
				yield* fs.writeFileString(path.join(folder, "journal.next"), "unacknowledged");
				yield* fs.writeFileString(path.join(folder, "owner.json"), "retained owner");
			}
			if (mode === "symlink") {
				yield* fs.rename(path.join(folder, "journal.json"), path.join(folder, "elsewhere.json"));
				yield* fs.symlink(path.join(folder, "elsewhere.json"), path.join(folder, "journal.json"));
			}
		}
		const boot =
			mode === "source" || mode === "empty" || mode === "next"
				? yield* parseDescriptor("postgres://boot:fixture@localhost/source_boot")
				: selected;
		const work = Effect.gen(function* () {
			const admissions = yield* readTransferAdmission({ dataDirectory: directory, boot });
			if (mode === "sql-in-progress")
				yield* assertTransferActivation([{ key: "transfer_state", value: "in_progress" }], {
					dataDirectory: directory,
					boot,
				});
			if (mode === "missing-sql" || mode === "complete" || mode === "history") {
				const activeBinding =
					mode === "history" ? { ...binding, transfer_id: "33333333-3333-4333-8333-333333333333" } : binding;
				const rows =
					mode === "missing-sql"
						? []
						: [
								{ key: "transfer_state", value: "complete" },
								{ key: "app_store_id", value: selection.store_id },
								{ key: "transfer_journal", value: JSON.stringify({ binding: activeBinding, phase: "complete" }) },
							];
				yield* assertTransferActivation(rows, { dataDirectory: directory, boot, admissions });
			}
		});
		const result = yield* work.pipe(Effect.result);
		if (mode === "next" && (yield* fs.readFileString(path.join(folder, "owner.json"))) !== "retained owner")
			return yield* Effect.die("Owner evidence changed");
		if (mode === "empty" && ((yield* fs.readDirectory(folder)).length !== 0 || !(yield* fs.exists(folder))))
			return yield* Effect.die("Empty owner directory changed");
		yield* Console.log(JSON.stringify({ result, bootCreated: yield* fs.exists(selected.filename) }));
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
