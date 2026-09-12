import { on } from "@comms/storage/dialect";
import {
	TransferRejected,
	validateTransferSelection,
	type TransferSelection,
} from "@comms/storage/store-transfer-schema";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { prepareControlSettings } from "./control-settings.ts";

const invalid = () => new TransferRejected({ code: "transfer_verification_failed" });
const Sequence = Schema.Struct({
	singleton: Schema.Int,
	next: Schema.Int,
	published_through: Schema.Int,
	pending_id: Schema.NullOr(Schema.String),
	pending_attempt: Schema.NullOr(Schema.String),
	pending_from: Schema.NullOr(Schema.Int),
	pending_to: Schema.NullOr(Schema.Int),
});
const Identity = Schema.Struct({
	singleton: Schema.Int,
	store_id: Schema.String,
	initialized_at: Schema.Int,
	transferred_to: Schema.NullOr(Schema.String),
});
const Writer = Schema.Struct({ singleton: Schema.Int, epoch: Schema.String });
const readSequence = (sql: SqlClient) =>
	sql`SELECT singleton,${sql("next")},published_through,pending_id,pending_attempt,pending_from,pending_to FROM seq`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Sequence))),
	);
const lockSequence = (sql: SqlClient) =>
	on(sql, {
		sqlite: () => Effect.void,
		pg: () => sql`SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE`.pipe(Effect.asVoid),
		mysql: () => sql`SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE`.pipe(Effect.asVoid),
	});

/** Special tables are excluded from generic row copy. Target kernel provisioning must already
 * have installed this exact identity and a fresh epoch, under the durable incomplete marker.
 * No source authority is mutated here; retirement belongs to the cross-store coordinator. */
export const prepareControlTransfer = (options: {
	readonly sourceBoot: SqlClient;
	readonly sourceApp: SqlClient;
	readonly targetBoot: SqlClient;
	readonly targetApp: SqlClient;
	readonly selection: TransferSelection;
	readonly initializedAt: number;
	readonly epoch: string;
}) =>
	Effect.gen(function* () {
		const { sourceBoot, sourceApp, targetBoot, targetApp, initializedAt, epoch } = options;
		const selection = yield* validateTransferSelection(options.selection);
		if (!Number.isSafeInteger(initializedAt) || initializedAt < 0 || !/^[0-9a-f]{64}(?![\s\S])/.test(epoch))
			return yield* invalid();
		const sourceRows = yield* readSequence(sourceBoot);
		const source = sourceRows[0];
		if (
			sourceRows.length !== 1 ||
			!source ||
			source.singleton !== 1 ||
			!Number.isSafeInteger(source.next) ||
			source.next < 1 ||
			!Number.isSafeInteger(source.published_through) ||
			source.published_through < 0 ||
			source.published_through !== source.next - 1 ||
			source.pending_id !== null ||
			source.pending_attempt !== null ||
			source.pending_from !== null ||
			source.pending_to !== null
		)
			return yield* new TransferRejected({ code: "transfer_recovery_pending" });
		const identity = (sql: SqlClient, allowRetired: boolean) =>
			Effect.gen(function* () {
				const found = yield* sql`SELECT singleton,store_id,initialized_at,transferred_to FROM store_identity`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Identity))),
				);
				const row = found[0];
				if (
					found.length !== 1 ||
					!row ||
					row.singleton !== 1 ||
					row.store_id !== selection.store_id ||
					row.initialized_at !== initializedAt ||
					(!allowRetired && row.transferred_to !== null)
				)
					return yield* invalid();
			});
		// The caller validates any source retirement marker against the exact bound transfer.
		yield* identity(sourceApp, true);
		const writer = (sql: SqlClient) =>
			sql`SELECT singleton,epoch FROM kernel_writer`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Writer))),
			);
		const sourceWriter = yield* writer(sourceApp);
		if (sourceWriter.length !== 1 || sourceWriter[0]?.singleton !== 1 || sourceWriter[0]?.epoch === epoch)
			return yield* invalid();
		const verifyKernel = Effect.gen(function* () {
			yield* identity(targetApp, false);
			const found = yield* writer(targetApp);
			if (found.length !== 1 || found[0]?.singleton !== 1 || found[0]?.epoch !== epoch) return yield* invalid();
		});
		yield* verifyKernel;
		const settings = yield* prepareControlSettings(sourceBoot, targetBoot, selection, initializedAt);
		const verifySequence = Effect.gen(function* () {
			const found = yield* readSequence(targetBoot);
			if (found.length !== 1 || JSON.stringify(found[0]) !== JSON.stringify(source)) return yield* invalid();
		});
		const copySequence = targetBoot.withTransaction(
			Effect.gen(function* () {
				yield* lockSequence(targetBoot);
				const found = yield* readSequence(targetBoot);
				const row = found[0];
				if (found.length !== 1 || !row || row.singleton !== 1) return yield* invalid();
				if (JSON.stringify(row) === JSON.stringify(source)) return;
				if (
					row.next !== 1 ||
					row.published_through !== 0 ||
					row.pending_id !== null ||
					row.pending_attempt !== null ||
					row.pending_from !== null ||
					row.pending_to !== null
				)
					return yield* invalid();
				yield* targetBoot`UPDATE seq SET ${targetBoot("next")}=${source.next},published_through=${source.published_through} WHERE singleton=1`;
				yield* verifySequence;
			}),
		);
		return {
			manifest: {
				settings: settings.manifest,
				sequence: { next: source.next, published_through: source.published_through },
				identity: { store_id: selection.store_id, initialized_at: initializedAt },
				epoch,
			},
			copySequence,
			copyRemaining: verifySequence.pipe(Effect.andThen(settings.copy), Effect.andThen(verifyKernel)),
			verify: verifySequence.pipe(Effect.andThen(settings.verify), Effect.andThen(verifyKernel)),
		};
	});
