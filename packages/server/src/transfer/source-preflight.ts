import { on } from "@comms/storage/dialect";
import { withDatabase, type Store } from "@comms/storage/store";
import {
	bindingText,
	transferProtocol,
	TransferRejected,
	type TransferBinding,
} from "@comms/storage/store-transfer-schema";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

const rejected = (code: TransferRejected["code"] = "transfer_recovery_pending") => new TransferRejected({ code });
const pending = (reason: string) =>
	Console.error(JSON.stringify({ event: "store_transfer_source_refused", reason })).pipe(
		Effect.andThen(Effect.fail(rejected())),
	);
const Identity = Schema.Struct({ store_id: Schema.String, initialized_at: Schema.Int });
const Adoption = Schema.Struct({
	...Identity.fields,
	phase: Schema.Literal("ready"),
	filename: Schema.optionalKey(Schema.String),
	mode: Schema.optionalKey(Schema.Literals(["fresh", "legacy"])),
	engine: Schema.optionalKey(Schema.Literals(["postgres", "mysql"])),
	database: Schema.optionalKey(Schema.String),
});
const read = (boot: SqlClient, resumeBinding?: TransferBinding) =>
	Effect.gen(function* () {
		const ledger = yield* boot`SELECT migration_id,name FROM boot_migrations ORDER BY migration_id`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String }))),
			),
		);
		if (
			ledger.length !== transferProtocol.id ||
			ledger.some((row, index) => row.migration_id !== index + 1) ||
			ledger.at(-1)?.name !== transferProtocol.name
		)
			return yield* rejected("transfer_protocol_unsupported");
		yield* on<Effect.Effect<void, SqlError | TransferRejected>>(boot, {
			sqlite: () =>
				Effect.gen(function* () {
					const rows = yield* boot`PRAGMA user_version`;
					if (rows[0]?.user_version !== transferProtocol.id) return yield* rejected("transfer_protocol_unsupported");
				}),
			pg: () => Effect.void,
			mysql: () => Effect.void,
		});
		const rows = yield* boot`SELECT ${boot("key")},value FROM settings`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
			),
		);
		const value = (key: string) => rows.find((row) => row.key === key)?.value;
		const retired = value("transferred_to");
		if (retired !== undefined && (!resumeBinding || retired !== bindingText(resumeBinding)))
			return yield* rejected("transfer_source_retired");
		if (value("transfer_state") !== undefined && value("transfer_state") !== "complete")
			return yield* pending("transfer_incomplete");
		const adoption = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Adoption))(
			value("app_store_adoption"),
		).pipe(Effect.mapError(() => rejected("transfer_identity_mismatch")));
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(adoption.store_id) ||
			adoption.initialized_at < 0 ||
			value("app_store_id") !== adoption.store_id ||
			value("app_store_initialized") === undefined
		)
			return yield* rejected("transfer_identity_mismatch");
		if (resumeBinding && resumeBinding.store_id !== adoption.store_id)
			return yield* rejected("transfer_identity_mismatch");
		return { adoption, rows, value };
	});

/** Read boot before opening the app. The caller holds offline ownership and verifies prior transfer activation receipts before this call. This never migrates or repairs either store. */
export const resolveTransferSource = (
	config: {
		readonly app: Store;
		readonly assertActivated?: Effect.Effect<void, TransferRejected, FileSystem.FileSystem | Path.Path>;
	},
	boot: SqlClient,
	resumeBinding?: TransferBinding,
) =>
	Effect.gen(function* () {
		const { adoption, value } = yield* read(boot, resumeBinding);
		// The app client must not exist until every durable child owner is closed.
		if ((yield* boot`SELECT 1 FROM child_attempts WHERE closed<>1 LIMIT 1`).length) return yield* rejected();
		// Bound by the caller to the actual boot descriptor and held volume; SQL complete alone is insufficient.
		if (value("transfer_state") !== undefined || value("transfer_journal") !== undefined) {
			if (!config.assertActivated) return yield* pending("activation_unverified");
			yield* config.assertActivated;
		}
		if (config.app._tag !== "file") {
			if (
				adoption.engine !== config.app._tag ||
				adoption.database !== value("app_store_database") ||
				!adoption.database
			)
				return yield* rejected("transfer_identity_mismatch");
			return yield* withDatabase(config.app, adoption.database).pipe(
				Effect.mapError(() => rejected("transfer_identity_mismatch")),
			);
		}
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const filename = config.app.filename;
		const canonical = path.join(yield* fs.realPath(path.dirname(filename)), path.basename(filename));
		if (
			adoption.filename !== canonical ||
			!adoption.mode ||
			(value("app_store_layout") !== undefined && value("app_store_layout") !== "ready") ||
			(yield* fs.realPath(filename)) !== canonical ||
			(yield* fs.stat(filename)).type !== "File"
		)
			return yield* rejected("transfer_identity_mismatch");
		return { _tag: "file", filename: canonical } satisfies Store;
	});

/** Inspect actual protocol-20 tables under the caller's stable offline scope. Missing tables are errors, never empty evidence. */
export const inspectTransferSource = (
	boot: SqlClient,
	app: SqlClient,
	selected: Store,
	resumeBinding?: TransferBinding,
) =>
	Effect.gen(function* () {
		const { adoption, rows, value } = yield* read(boot, resumeBinding);
		if (
			selected._tag === "file"
				? adoption.filename !== selected.filename
				: adoption.engine !== selected._tag ||
					adoption.database !== selected.database ||
					value("app_store_database") !== selected.database
		)
			return yield* rejected("transfer_identity_mismatch");
		const writers = yield* app`SELECT singleton,epoch FROM kernel_writer`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ singleton: Schema.Literal(1), epoch: Schema.String }))),
			),
		);
		if (writers.length !== 1 || !writers[0]?.epoch) return yield* pending("writer_identity");
		const progress = value("app_store_schema");
		if (progress !== undefined) {
			const saved = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({
						store_id: Schema.String,
						initialized_at: Schema.Int,
						operations: Schema.Array(Schema.String),
						next: Schema.Int,
						active: Schema.NullOr(Schema.String),
					}),
				),
			)(progress).pipe(
				Effect.tapError(() =>
					Console.error(JSON.stringify({ event: "store_transfer_source_refused", reason: "app_schema_shape" })),
				),
				Effect.mapError(() => rejected()),
			);
			if (
				saved.store_id !== adoption.store_id ||
				saved.initialized_at !== adoption.initialized_at ||
				saved.active !== null ||
				saved.next !== saved.operations.length
			)
				return yield* pending("app_schema_incomplete");
		}
		const identities = yield* app`SELECT singleton,store_id,initialized_at,transferred_to FROM store_identity`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							...Identity.fields,
							singleton: Schema.Literal(1),
							transferred_to: Schema.NullOr(Schema.String),
						}),
					),
				),
			),
		);
		const identity = identities[0];
		if (
			identities.length !== 1 ||
			!identity ||
			identity.store_id !== adoption.store_id ||
			identity.initialized_at !== adoption.initialized_at
		)
			return yield* rejected("transfer_identity_mismatch");
		if (
			identity.transferred_to !== null &&
			(!resumeBinding ||
				identity.transferred_to !== bindingText(resumeBinding) ||
				value("transferred_to") !== identity.transferred_to)
		)
			return yield* rejected("transfer_source_retired");
		const seq =
			yield* boot`SELECT singleton,next,published_through,pending_id,pending_attempt,pending_from,pending_to FROM seq`;
		const state = seq[0];
		if (
			seq.length !== 1 ||
			!state ||
			state.singleton !== 1 ||
			typeof state.next !== "number" ||
			!Number.isSafeInteger(state.next) ||
			typeof state.published_through !== "number" ||
			!Number.isSafeInteger(state.published_through) ||
			state.published_through < 0 ||
			state.next !== state.published_through + 1 ||
			state.pending_id !== null ||
			state.pending_attempt !== null ||
			state.pending_from !== null ||
			state.pending_to !== null
		)
			return yield* pending("sequence_pending");
		for (const [reason, query] of [
			["cutover_pending", boot`SELECT 1 FROM cutover LIMIT 1`],
			[
				"restore_pending",
				boot`SELECT 1 FROM db_restore_requests WHERE phase NOT IN ('restored','failed') OR lock_id IS NOT NULL LIMIT 1`,
			],
			["source_batch_pending", boot`SELECT 1 FROM source_batches WHERE state<>'published' LIMIT 1`],
			["source_changes_pending", boot`SELECT 1 FROM source_changes LIMIT 1`],
			["edit_lock_pending", boot`SELECT 1 FROM edit_lock LIMIT 1`],
			["staging_pending", boot`SELECT 1 FROM staging LIMIT 1`],
			["child_closure_pending", boot`SELECT 1 FROM child_attempts WHERE closed<>1 LIMIT 1`],
			["event_batch_pending", boot`SELECT 1 FROM event_batches WHERE state NOT IN ('published','aborted') LIMIT 1`],
			["outbox_pending", app`SELECT 1 FROM outbox WHERE shipped_at IS NULL OR seq>${state.published_through} LIMIT 1`],
			["topic_continuation_pending", app`SELECT 1 FROM topic_page_continuations WHERE completed<>1 LIMIT 1`],
		] as const)
			if ((yield* query).length) return yield* pending(reason);
		if (value("sqlite_copy") !== undefined || value("app_store_layout") === "moving")
			return yield* pending("file_recovery_pending");
		for (const row of rows) {
			if (row.key.startsWith("source-revert-result:")) {
				const receipt = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(
						Schema.Struct({ outcome: Schema.NullOr(Schema.Struct({ status: Schema.Int, body: Schema.Json })) }),
					),
				)(row.value).pipe(Effect.mapError(() => rejected()));
				if (receipt.outcome === null) return yield* pending("source_revert_pending");
			}
			if (row.key.startsWith("remote_database:")) {
				const record = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Struct({ phase: Schema.Literal("closed") })),
				)(row.value).pipe(
					Effect.tapError(() =>
						Console.error(
							JSON.stringify({ event: "store_transfer_source_refused", reason: "remote_resource_not_closed" }),
						),
					),
					Effect.mapError(() => rejected()),
				);
				if (record.phase !== "closed") return yield* pending("remote_resource_not_closed");
			}
		}
		yield* on<Effect.Effect<void, SqlError | TransferRejected>>(boot, {
			sqlite: () => Effect.void,
			pg: () => Effect.void,
			mysql: () =>
				Effect.gen(function* () {
					if ((yield* boot`SELECT 1 FROM boot_migrations_intent LIMIT 1`).length)
						return yield* pending("boot_migration_pending");
				}),
		});
		yield* on<Effect.Effect<void, SqlError | TransferRejected>>(app, {
			sqlite: () => Effect.void,
			pg: () => Effect.void,
			mysql: () =>
				Effect.gen(function* () {
					if (
						(yield* app`SELECT 1 FROM kernel_migration_intent LIMIT 1`).length ||
						(yield* app`SELECT 1 FROM core_migrations_intent LIMIT 1`).length
					)
						return yield* pending("app_migration_pending");
				}),
		});
		const generations =
			yield* boot`SELECT n,entry_file,snapshot_dir FROM generations WHERE good=1 AND snapshot_dir IS NOT NULL ORDER BY n DESC LIMIT 1`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ n: Schema.Int, entry_file: Schema.String, snapshot_dir: Schema.String })),
					),
				),
			);
		const generation = generations[0];
		if (!generation || generation.n < 1) return yield* pending("frozen_generation_missing");
		return { store_id: identity.store_id, initialized_at: identity.initialized_at, generation };
	});
