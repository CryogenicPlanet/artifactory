import { assertTransferActivation, sqliteTransferSafetyCopy, nativeTransferSafetyCopy } from "@comms/boot";
import { withDatabase } from "@comms/storage/store";
import type { TransferBinding } from "@comms/storage/store-transfer-schema";
import { SqlClient } from "effect/unstable/sql";
import { transferEndpoint } from "./endpoint.ts";
import { resolveTransferSource, inspectTransferSource } from "./source-preflight.ts";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
	TransferRejected,
	validateTransferSelection,
	type TransferSelection,
} from "@comms/storage/store-transfer-schema";

const invalid = () => new TransferRejected({ code: "transfer_verification_failed" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Incomplete capture directories are evidence, never a reason to erase or adopt their bytes. */
const safetyReceipts = (selection: TransferSelection) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = selection.data_directory;
		if ((yield* fs.realPath(root)) !== root) return yield* invalid();
		let parent = root;
		for (const name of ["transfers", selection.transfer_id, "safety"]) {
			if (!(yield* fs.readDirectory(parent)).includes(name)) return [];
			parent = path.join(parent, name);
			if ((yield* fs.realPath(parent)) !== parent || (yield* fs.stat(parent)).type !== "Directory")
				return yield* invalid();
		}
		const receipts: string[] = [];
		for (const entry of (yield* fs.readDirectory(parent)).sort()) {
			if (!uuid.test(entry)) continue;
			const directory = path.join(parent, entry);
			if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).type !== "Directory")
				return yield* invalid();
			if (!(yield* fs.readDirectory(directory)).includes("receipt.json")) continue;
			const filename = path.join(directory, "receipt.json");
			if ((yield* fs.realPath(filename)) !== filename || (yield* fs.stat(filename)).type !== "File")
				return yield* invalid();
			receipts.push(filename);
		}
		return receipts;
	});

type Configuration = Parameters<typeof transferEndpoint>[0];
type Owner = Parameters<typeof transferEndpoint>[1];
export interface SourceReadOptions {
	readonly configuration: Configuration;
	readonly owner: Owner;
	readonly dataDirectory: string;
	readonly resumeBinding?: TransferBinding;
}

/** Materialized evidence only: all inspection pools close before the caller may take opaque safety copies. */
export const readTransferSource = (options: SourceReadOptions) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const bootStore = options.configuration.boot;
			if (
				bootStore._tag === "file" &&
				((yield* fs.realPath(bootStore.filename)) !== bootStore.filename ||
					(yield* fs.stat(bootStore.filename)).type !== "File")
			)
				return yield* invalid();
			const endpoint = yield* transferEndpoint(options.configuration, options.owner, true);
			const rows = yield* endpoint.boot`SELECT ${endpoint.boot("key")},value FROM settings`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
				),
			);
			const selected = yield* resolveTransferSource(
				{
					app: options.configuration.app,
					assertActivated: assertTransferActivation(rows, {
						dataDirectory: options.dataDirectory,
						boot: options.configuration.boot,
					}).pipe(Effect.mapError(invalid)),
				},
				endpoint.boot,
				options.resumeBinding,
			);
			if (bootStore._tag === "file" && selected._tag === "file") {
				const bootStat = yield* fs.stat(bootStore.filename);
				const appStat = yield* fs.stat(selected.filename);
				if (
					appStat.type !== "File" ||
					(yield* fs.realPath(selected.filename)) !== selected.filename ||
					Option.isNone(bootStat.ino) ||
					Option.isNone(appStat.ino) ||
					(bootStat.ino.value === appStat.ino.value && bootStat.dev === appStat.dev)
				)
					return yield* invalid();
			}
			const proof = yield* endpoint.withApp(
				selected,
				Effect.gen(function* () {
					return yield* inspectTransferSource(
						endpoint.boot,
						yield* SqlClient.SqlClient,
						selected,
						options.resumeBinding,
					);
				}),
			);
			return { selected, proof };
		}),
	);
export type TransferSourceEvidence = Effect.Success<ReturnType<typeof readTransferSource>>;
interface SafetyOptions {
	readonly configuration: Configuration;
	readonly owner: Owner;
	readonly selection: TransferSelection;
	readonly sourceEvidence: TransferSourceEvidence;
}
const selectedSource = (options: SafetyOptions) =>
	Effect.gen(function* () {
		const { selection, configuration, sourceEvidence } = options;
		yield* validateTransferSelection(selection);
		const selected = sourceEvidence.selected;
		if (sourceEvidence.proof.store_id !== selection.store_id) return yield* invalid();
		if (configuration._tag === "file") {
			if (
				selected._tag !== "file" ||
				selection.source.engine !== "sqlite" ||
				selection.source.boot !== configuration.boot.filename ||
				selection.source.app !== selected.filename
			)
				return yield* invalid();
			return { configuration, app: selected };
		}
		if (
			selected._tag === "file" ||
			selection.source.engine !== (selected._tag === "postgres" ? "pg" : "mysql") ||
			selection.source.boot !== configuration.boot.database ||
			selection.source.app !== selected.database
		)
			return yield* invalid();
		const app = yield* withDatabase(configuration.app, selected.database);
		return { configuration, app };
	});

/** Recheck durable local owners with a short read-only boot scope, then close it before opaque copy starts. */
const assertSqliteClosed = (configuration: Configuration, owner: Owner) =>
	Effect.scoped(
		Effect.gen(function* () {
			const endpoint = yield* transferEndpoint(configuration, owner, true);
			if ((yield* endpoint.boot`SELECT 1 FROM child_attempts WHERE closed<>1 LIMIT 1`).length)
				return yield* new TransferRejected({ code: "transfer_recovery_pending" });
		}),
	);

/** Revoke only exact journaled temporary dump resources under the existing remote guardian. */
export const recoverSourceSafety = (options: SafetyOptions) =>
	Effect.scoped(
		Effect.gen(function* () {
			const source = yield* selectedSource(options);
			if (source.configuration._tag === "file") return;
			if (source.app._tag === "file") return yield* invalid();
			const endpoint = yield* transferEndpoint(source.configuration, options.owner, true);
			if (!endpoint.runtime) return yield* invalid();
			const adapter = yield* nativeTransferSafetyCopy({
				selection: options.selection,
				source: { boot: source.configuration.boot, app: source.app },
				runtime: endpoint.runtime,
				budgetMs: 120000,
			});
			yield* adapter.recover;
		}),
	);

/** Reuse verified receipts only. A bound resume cannot silently capture a replacement before-image. */
export const ensureSourceSafety = (options: SafetyOptions & { readonly requireExisting: boolean }) =>
	Effect.gen(function* () {
		const source = yield* selectedSource(options);
		const receipts = yield* safetyReceipts(options.selection);
		if (options.requireExisting && receipts.length === 0) return yield* invalid();
		if (source.configuration._tag === "file") {
			if (source.app._tag !== "file") return yield* invalid();
			const adapter = yield* sqliteTransferSafetyCopy({
				dataDirectory: options.selection.data_directory,
				transferId: options.selection.transfer_id,
				storeId: options.selection.store_id,
				source: { boot: source.configuration.boot, app: source.app },
				assertAllClosed: assertSqliteClosed(source.configuration, options.owner),
			});
			for (const receipt of receipts) yield* adapter.verify(receipt);
			const existing = receipts[0];
			return existing ?? (yield* adapter.capture).path;
		}
		if (source.app._tag === "file") return yield* invalid();
		const remoteSource = { boot: source.configuration.boot, app: source.app };
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const endpoint = yield* transferEndpoint(source.configuration, options.owner, true);
				if (!endpoint.runtime) return yield* invalid();
				const adapter = yield* nativeTransferSafetyCopy({
					selection: options.selection,
					source: remoteSource,
					runtime: endpoint.runtime,
					budgetMs: 120000,
				});
				yield* adapter.recover;
				for (const receipt of receipts) yield* adapter.verify(receipt);
				const existing = receipts[0];
				return existing ?? (yield* adapter.capture).path;
			}),
		);
	});
