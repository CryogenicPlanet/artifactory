import {
	makeTransferBootstrap,
	assertChildAttemptsClosed,
	makeTransferKernelInitializer,
	preflightTransferAppSource,
	runTransferApp,
	snapshotStoreEntry,
} from "@comms/boot";
import { transferInventory } from "@comms/storage/transfer-inventory";
import { writeTransferReceipt } from "@comms/storage/store-transfer-receipt";
import {
	bindingText,
	selectionText,
	TransferFileJournal,
	TransferRejected,
	type TransferPreparation,
} from "@comms/storage/store-transfer-schema";
import { Cause, Console, Config, Crypto, Effect, FileSystem, Option, Path, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import type { RemoteTransferConfiguration } from "@comms/boot";
import type { decodeTransferConfiguration } from "./configuration.ts";
import { transferEndpoint } from "./endpoint.ts";
import { readTransferSource, ensureSourceSafety, recoverSourceSafety } from "./source-session.ts";
import { transferSelection } from "./selection.ts";
import { MigrationProof, readMigrationProof, writeMigrationProof } from "./migration-proof.ts";
import { prepareTransfer } from "./prepare.ts";
import { clearTransferSeeds } from "./clear-seeds.ts";
import { transferStores } from "../store-transfer-coordinator.ts";
import { postgresSearchDeclarations } from "./search-capability.ts";
import { bootDerivedObjects, coreJsonColumns, coreSearchObjects } from "./derived-schema.ts";

const invalid = () => new TransferRejected({ code: "transfer_journal_conflict" });
// Only fixed phase names and schema-validated protocol codes leave this immutable worker.
// Driver messages, SQL, descriptors and arbitrary error payloads never enter diagnostics.
export const transferStage = (stage: string) =>
	Effect.onError((cause: Cause.Cause<unknown>) => {
		const failure = Cause.findErrorOption(cause);
		const error = Option.isSome(failure) ? failure.value : undefined;
		const code = Schema.is(TransferRejected)(error) ? error.code : "transfer_operation_failed";
		if (Schema.is(SqlError.SqlError)(error)) {
			const driver = error.reason.cause;
			const state =
				typeof driver === "object" && driver !== null && "sqlState" in driver
					? driver.sqlState
					: typeof driver === "object" && driver !== null && "code" in driver
						? driver.code
						: undefined;
			const errno = typeof driver === "object" && driver !== null && "errno" in driver ? driver.errno : undefined;
			return Console.error(
				JSON.stringify({
					event: "store_transfer_failure",
					stage,
					code: "sql_error",
					reason: error.reason._tag,
					...(typeof state === "string" && /^[0-9A-Z]{5}(?![\s\S])/.test(state) ? { sqlstate: state } : {}),
					...(typeof errno === "number" && Number.isSafeInteger(errno) && errno > 0 && errno < 100000 ? { errno } : {}),
				}),
			);
		}
		return Console.error(JSON.stringify({ event: "store_transfer_failure", stage, code }));
	});

type Configuration = Effect.Success<ReturnType<typeof decodeTransferConfiguration>>;

/** Existing ancestors and files are checked before opening SQLite. Creating only these
 * already-bound parents does not grant ownership of any preexisting database objects. */
export const targetDirectories = (preparation: TransferPreparation) =>
	Effect.gen(function* () {
		const selection = preparation.selection;
		if (selection.target.engine !== "sqlite") return;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		for (const filename of [selection.target.boot, selection.target.app]) {
			let parent = selection.data_directory;
			const relative = path.relative(parent, path.dirname(filename));
			for (const part of relative === "" ? [] : relative.split(path.sep)) {
				if (!part || part === "." || part === "..") return yield* invalid();
				const next = path.join(parent, part);
				if (!(yield* fs.readDirectory(parent)).includes(part)) {
					yield* fs.makeDirectory(next, { mode: 0o700 });
					yield* Effect.scoped(fs.open(parent).pipe(Effect.flatMap((file) => file.sync)));
				}
				if ((yield* fs.realPath(next)) !== next || (yield* fs.stat(next)).type !== "Directory") return yield* invalid();
				parent = next;
			}
			if (
				(yield* fs.readDirectory(parent)).includes(path.basename(filename)) &&
				((yield* fs.realPath(filename)) !== filename || (yield* fs.stat(filename)).type !== "File")
			)
				return yield* invalid();
		}
		if ((yield* fs.exists(selection.target.boot)) && (yield* fs.exists(selection.target.app))) {
			const boot = yield* fs.stat(selection.target.boot);
			const app = yield* fs.stat(selection.target.app);
			if (
				Option.isNone(boot.ino) ||
				Option.isNone(app.ino) ||
				(boot.dev === app.dev && boot.ino.value === app.ino.value)
			)
				return yield* invalid();
		}
	});

/** Immutable SQL worker under the outer image flock and both surviving guardians. No
 * editable code executes in this process; all callback results stay inside this scope. */
export const runStoreTransferWorker = (configuration: Configuration, owners: typeof RemoteTransferConfiguration.Type) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const crypto = yield* Crypto.Crypto;
			const dataDirectory = "/data";
			if (
				process.platform !== "linux" ||
				(yield* Config.String("COMMS_LOCKED_COMMAND")) !== "store-transfer" ||
				(yield* fs.realPath(dataDirectory)) !== dataDirectory ||
				owners.transferId !== configuration.transferId
			)
				return yield* invalid();
			const directory = path.join(dataDirectory, "transfers", configuration.transferId);
			const journalFile = path.join(directory, "journal.json");
			const existing = yield* Effect.gen(function* () {
				if (!(yield* fs.readDirectory(directory)).includes("journal.json")) return undefined;
				const stat = yield* fs.stat(journalFile);
				if (stat.type !== "File" || stat.size > 32768 || (yield* fs.realPath(journalFile)) !== journalFile)
					return yield* invalid();
				return yield* fs
					.readFileString(journalFile)
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TransferFileJournal))));
			});
			if (existing?.phase === "complete") return yield* invalid();
			const resumeBinding = existing?.phase === "in_progress" ? existing.binding : undefined;
			const sourceEvidence = yield* readTransferSource({
				configuration: configuration.source,
				owner: owners.source,
				dataDirectory,
				...(resumeBinding ? { resumeBinding } : {}),
			}).pipe(transferStage("source_inspection"));
			const selection = yield* transferSelection({
				transferId: configuration.transferId,
				storeId: sourceEvidence.proof.store_id,
				dataDirectory,
				mode: configuration.mode,
				source: { boot: configuration.source.boot, app: sourceEvidence.selected },
				target: configuration.target,
			});
			if (
				existing &&
				selectionText(existing.phase === "preparing" ? existing.selection : existing.binding) !==
					selectionText(selection)
			)
				return yield* invalid();
			const generation = sourceEvidence.proof.generation;
			yield* snapshotStoreEntry(generation, dataDirectory, configuration.target.app).pipe(
				transferStage("source_capability"),
			);
			yield* preflightTransferAppSource(generation.snapshot_dir).pipe(transferStage("migration_capability"));
			let proof: MigrationProof | undefined = yield* readMigrationProof(selection);
			if (resumeBinding && !proof) return yield* invalid();
			const preparation: TransferPreparation =
				existing?.phase === "preparing"
					? existing
					: {
							selection,
							initialized_at: sourceEvidence.proof.initialized_at,
							epoch: proof?.epoch ?? Buffer.from(yield* crypto.randomBytes(32)).toString("hex"),
							phase: "preparing",
							sentinel: proof ? "ready" : "pending",
						};
			if (preparation.initialized_at !== sourceEvidence.proof.initialized_at) return yield* invalid();
			if (!existing) yield* writeTransferReceipt(preparation);
			const safetyOptions = { configuration: configuration.source, owner: owners.source, selection, sourceEvidence };
			const safetyReceipt = yield* ensureSourceSafety({
				...safetyOptions,
				requireExisting: resumeBinding !== undefined || proof !== undefined,
			}).pipe(transferStage("source_safety_copy"));
			if (
				proof &&
				(proof.epoch !== preparation.epoch ||
					proof.initialized_at !== preparation.initialized_at ||
					proof.generation.n !== generation.n ||
					proof.generation.entry_file !== generation.entry_file ||
					proof.generation.snapshot_dir !== generation.snapshot_dir ||
					proof.safetyReceipt !== safetyReceipt)
			)
				return yield* invalid();
			yield* targetDirectories(preparation).pipe(transferStage("target_paths"));
			const target = yield* transferEndpoint(configuration.target, owners.target).pipe(
				transferStage("target_connection"),
			);
			if (!proof) {
				const stores = { bootStore: configuration.target.boot, appStore: configuration.target.app };
				const bootstrap = yield* makeTransferBootstrap(stores).pipe(
					Effect.provideService(SqlClient.SqlClient, target.boot),
				);
				yield* target
					.withApp(
						configuration.target.app,
						bootstrap(preparation, writeTransferReceipt({ ...preparation, sentinel: "ready" })),
					)
					.pipe(transferStage("target_bootstrap"));
				const initialize = yield* makeTransferKernelInitializer(stores).pipe(
					Effect.provideService(SqlClient.SqlClient, target.boot),
				);
				yield* target
					.withApp(
						configuration.target.app,
						initialize(selection, { initialized_at: preparation.initialized_at, epoch: preparation.epoch }),
					)
					.pipe(transferStage("target_kernel"));
				const attempt = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
				const remote =
					target.runtime && configuration.target.app._tag !== "file"
						? yield* target.runtime.reserveOwner(configuration.target.app, attempt)
						: undefined;
				const encoded = yield* runTransferApp({
					sourceDirectory: generation.snapshot_dir,
					transferDirectory: directory,
					dataDirectory,
					targetStore: configuration.target.app,
					epoch: preparation.epoch,
					sourceEngine: selection.source.engine,
					attempt,
					...(remote ? { remote } : {}),
					isolated: true,
				}).pipe(transferStage("app_migrations"));
				const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationProof.fields.result))(encoded);
				proof = {
					selection,
					initialized_at: preparation.initialized_at,
					epoch: preparation.epoch,
					generation,
					result,
					safetyReceipt,
				};
				yield* writeMigrationProof(proof);
			}
			const migrationProof = proof;
			const source = yield* transferEndpoint(configuration.source, owners.source);
			yield* source.withApp(
				sourceEvidence.selected,
				Effect.gen(function* () {
					const sourceApp = yield* SqlClient.SqlClient;
					yield* target.withApp(
						configuration.target.app,
						Effect.gen(function* () {
							const targetApp = yield* SqlClient.SqlClient;
							const inventory = (sql: SqlClient.SqlClient, engine: "sqlite" | "pg" | "mysql", store: "boot" | "app") =>
								Effect.gen(function* () {
									return yield* transferInventory(
										sql,
										engine === "sqlite"
											? store === "boot"
												? bootDerivedObjects
												: coreSearchObjects
											: engine === "pg" && store === "app"
												? yield* postgresSearchDeclarations(sql)
												: [],
										store === "app" ? coreJsonColumns : [],
									);
								}).pipe(transferStage(`catalog_${store}`));
							const inputs = {
								selection,
								mode: configuration.mode,
								initializedAt: preparation.initialized_at,
								epoch: preparation.epoch,
								generation,
								safetyReceipt,
								extensions: migrationProof.result.extensionProofs,
								source: {
									boot: source.boot,
									app: sourceApp,
									bootInventory: yield* inventory(source.boot, selection.source.engine, "boot"),
									appInventory: yield* inventory(sourceApp, selection.source.engine, "app"),
								},
								target: {
									boot: target.boot,
									app: targetApp,
									bootInventory: yield* inventory(target.boot, selection.target.engine, "boot"),
									appInventory: yield* inventory(targetApp, selection.target.engine, "app"),
								},
							};
							const prepared = yield* prepareTransfer(inputs).pipe(transferStage("logical_preflight"));
							if (resumeBinding && bindingText(resumeBinding) !== bindingText(prepared.binding))
								return yield* invalid();
							if (!resumeBinding) {
								yield* clearTransferSeeds(target.boot, targetApp, selection, {
									store: "app",
									tables: prepared.appTables,
								}).pipe(transferStage("target_seed_cleanup"));
								yield* writeTransferReceipt({ binding: prepared.binding, phase: "in_progress" });
							}
							if (prepared.kind === "check") return;
							const assertExclusive = Effect.gen(function* () {
								// The immutable outer lock and guardians hold the stores stable. Recheck durable
								// local child ownership as well; no repair or clearing inventories substitutes proof.
								yield* assertChildAttemptsClosed(source.boot, dataDirectory).pipe(
									Effect.provideService(FileSystem.FileSystem, fs),
									Effect.provideService(Path.Path, path),
									Effect.mapError(invalid),
								);
							});
							yield* transferStores(prepared.binding, {
								sourceBoot: source.boot,
								sourceApp,
								targetBoot: target.boot,
								targetApp,
								assertExclusive,
								copyAndVerify: prepared.copyAndVerify,
								reverify: prepared.reverify,
							}).pipe(transferStage("authority_handoff"));
							// SQL complete alone is insufficient, including a restart after SQL commit. This
							// final live comparison must succeed before the worker can authorize outer closure.
							if ((yield* prepared.reverify) !== prepared.binding.manifest) return yield* invalid();
						}),
					);
				}),
			);
			yield* recoverSourceSafety(safetyOptions).pipe(transferStage("source_resource_cleanup"));
		}),
	);
