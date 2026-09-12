import type { TransferInventory } from "@comms/storage/transfer-inventory";
import { makeTransferDigest } from "@comms/storage/transfer-values";
import { selectionText, validateTransferSelection, type TransferSelection } from "@comms/storage/store-transfer-schema";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { ExtensionMigrationProof } from "../kernel/transfer-extension-migrations.ts";
import { inspectControlSettings } from "./control-settings.ts";
import { prepareControlTransfer } from "./control-tables.ts";
import { prepareTransferData } from "./data-plan.ts";
import { ledgerProof } from "./ledger-proof.ts";

/** All inputs come from the held offline scope and its frozen migration-only worker.
 * This preparation reads both roles completely before returning any copy operation. */
export const prepareTransfer = (options: {
	readonly selection: TransferSelection;
	readonly mode: "check" | "transfer";
	readonly safetyReceipt: string;
	readonly initializedAt: number;
	readonly epoch: string;
	readonly generation: { readonly n: number; readonly entry_file: string; readonly snapshot_dir: string };
	readonly extensions: readonly ExtensionMigrationProof[];
	readonly source: {
		readonly boot: SqlClient;
		readonly app: SqlClient;
		readonly bootInventory: TransferInventory;
		readonly appInventory: TransferInventory;
	};
	readonly target: {
		readonly boot: SqlClient;
		readonly app: SqlClient;
		readonly bootInventory: TransferInventory;
		readonly appInventory: TransferInventory;
	};
}) =>
	Effect.gen(function* () {
		const selection = yield* validateTransferSelection(options.selection);
		const prepareRole = (store: "boot" | "app") =>
			prepareTransferData({
				store,
				source: {
					sql: options.source[store],
					engine: selection.source.engine,
					inventory: store === "boot" ? options.source.bootInventory : options.source.appInventory,
				},
				target: {
					sql: options.target[store],
					engine: selection.target.engine,
					inventory: store === "boot" ? options.target.bootInventory : options.target.appInventory,
				},
			});
		const boot = yield* prepareRole("boot");
		const app = yield* prepareRole("app");
		const readLedgers = Effect.gen(function* () {
			return {
				boot: yield* ledgerProof({
					store: "boot",
					source: options.source.boot,
					target: options.target.boot,
					ledgers: boot.ledgers,
					extensions: [],
				}),
				app: yield* ledgerProof({
					store: "app",
					source: options.source.app,
					target: options.target.app,
					ledgers: app.ledgers,
					extensions: options.extensions,
				}),
			};
		});
		const ledgers = yield* readLedgers;
		if (options.mode === "check") {
			const settings = yield* inspectControlSettings(options.source.boot, selection, options.initializedAt);
			const digest = yield* makeTransferDigest;
			for (const material of [
				"check",
				selectionText(selection),
				JSON.stringify(options.generation),
				options.safetyReceipt,
				JSON.stringify(ledgers),
				JSON.stringify(settings),
				JSON.stringify(boot.manifest),
				JSON.stringify(app.manifest),
			])
				yield* digest.append([{ kind: "text", value: material }]);
			return {
				kind: "check" as const,
				appTables: app.tables,
				binding: { ...selection, manifest: yield* digest.finish },
			};
		}
		const controls = yield* prepareControlTransfer({
			sourceBoot: options.source.boot,
			sourceApp: options.source.app,
			targetBoot: options.target.boot,
			targetApp: options.target.app,
			selection,
			initializedAt: options.initializedAt,
			epoch: options.epoch,
		});
		const fingerprint = (value: typeof ledgers) =>
			Effect.gen(function* () {
				const digest = yield* makeTransferDigest;
				for (const material of [
					selectionText(selection),
					options.safetyReceipt,
					JSON.stringify({
						n: options.generation.n,
						entry_file: options.generation.entry_file,
						snapshot_dir: options.generation.snapshot_dir,
					}),
					JSON.stringify(value),
					JSON.stringify(controls.manifest),
					JSON.stringify(boot.manifest),
					JSON.stringify(app.manifest),
				])
					yield* digest.append([{ kind: "text", value: material }]);
				return yield* digest.finish;
			});
		const manifest = yield* fingerprint(ledgers);
		const reverify = Effect.gen(function* () {
			yield* controls.verify;
			yield* boot.verify;
			yield* app.verify;
			return yield* fingerprint(yield* readLedgers);
		});
		const copyAndVerify = Effect.gen(function* () {
			yield* controls.copySequence;
			yield* boot.copy;
			yield* app.copy;
			yield* controls.copyRemaining;
			return yield* reverify;
		});
		return {
			kind: "transfer" as const,
			appTables: app.tables,
			binding: { ...selection, manifest },
			copyAndVerify,
			reverify,
		};
	});
