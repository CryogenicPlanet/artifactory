import { lockRow, on } from "@comms/storage/dialect";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
	bindingText,
	TransferJournal,
	TransferRejected,
	validateTransferBinding,
} from "@comms/storage/store-transfer-schema";
import type { TransferBinding, TransferPhase } from "@comms/storage/store-transfer-schema";

const Settings = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }));
const readSettings = (sql: SqlClient) =>
	sql`SELECT ${sql("key")},value FROM settings WHERE ${sql("key")} IN
		('transfer_state','transfer_journal','transferred_to','app_store_id')`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Settings)),
	);
const setting = (rows: typeof Settings.Type, key: string) => rows.find((row) => row.key === key)?.value;
const reject = (code: TransferRejected["code"]) => new TransferRejected({ code });
const writeSetting = (sql: SqlClient, key: string, value: string) =>
	on(sql, {
		sqlite: () =>
			sql`INSERT INTO settings(key,value) VALUES(${key},${value}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		pg: () =>
			sql`INSERT INTO settings(key,value) VALUES(${key},${value}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		mysql: () =>
			sql`INSERT INTO settings(${sql("key")},value) VALUES(${key},${value}) ON DUPLICATE KEY UPDATE value=${value}`,
	});
const lockBoot = (sql: SqlClient) =>
	sql`SELECT singleton FROM seq WHERE singleton=1 ${lockRow(sql)}`.pipe(
		Effect.flatMap((rows) => (rows.length === 1 ? Effect.void : Effect.fail(reject("transfer_recovery_pending")))),
	);
const identity = (sql: SqlClient) =>
	sql`SELECT store_id,transferred_to FROM store_identity WHERE singleton=1`.pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Array(
					Schema.Struct({
						store_id: Schema.String,
						transferred_to: Schema.NullOr(Schema.String),
					}),
				),
			),
		),
		Effect.flatMap((rows) =>
			rows.length === 1 && rows[0] ? Effect.succeed(rows[0]) : Effect.fail(reject("transfer_identity_mismatch")),
		),
	);

export interface TransferStores<E, R> {
	readonly sourceBoot: SqlClient;
	readonly sourceApp: SqlClient;
	readonly targetBoot: SqlClient;
	readonly targetApp: SqlClient;
	/** The caller holds the actual offline lease across this entire operation AND client
	 * closure. This assertion checks its still-held scope, opened descriptors and closure
	 * evidence; it must not merely observe an idle process at one instant. */
	readonly assertExclusive: Effect.Effect<void, E, R>;
	/** Copy resumes only this binding, preserves target control rows and binds target
	 * app identity. Every source table was preflighted before this first mutation.
	 * Partial copies must be verified or refused, never blindly appended. */
	readonly copyAndVerify: Effect.Effect<string, E, R>;
	/** Recompute the approved logical manifest, excluding explicitly transformed lifetime
	 * and control rows. Compare both stores, including source/target allocator watermarks. */
	readonly reverify: Effect.Effect<string, E, R>;
}

/** Durable SQL authority handoff, not a launcher or lease acquisition API. Target schemas
 * and minimal control rows must already be provisioned under an incomplete marker.
 * A successful result still requires the outer owner to close all clients/guardians and
 * publish its filesystem receipt before exposing the target for normal boot. */
export const transferStores = <E, R>(input: TransferBinding, stores: TransferStores<E, R>) =>
	Effect.gen(function* () {
		const binding = yield* validateTransferBinding(input);
		const marker = bindingText(binding);
		const { sourceBoot, sourceApp, targetBoot, targetApp } = stores;
		yield* stores.assertExclusive;
		for (const sql of [sourceBoot, sourceApp, targetBoot, targetApp])
			if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
				return yield* reject("transfer_recovery_pending");
		const checkTargetIdentity = Effect.gen(function* () {
			const target = yield* identity(targetApp);
			if (
				target.store_id !== binding.store_id ||
				target.transferred_to !== null ||
				setting(yield* readSettings(targetBoot), "app_store_id") !== binding.store_id
			)
				return yield* reject("transfer_identity_mismatch");
		});
		const readJournal = Effect.gen(function* () {
			const rows = yield* readSettings(targetBoot);
			if (setting(rows, "transferred_to") !== undefined) return yield* reject("transfer_target_retired");
			const text = setting(rows, "transfer_journal");
			if (text === undefined) {
				if (setting(rows, "transfer_state") !== "in_progress") return yield* reject("transfer_journal_conflict");
				return undefined;
			}
			const journal = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TransferJournal))(text).pipe(
				Effect.mapError(() => reject("transfer_journal_conflict")),
			);
			if (
				bindingText(journal.binding) !== marker ||
				setting(rows, "transfer_state") !== (journal.phase === "complete" ? "complete" : "in_progress")
			)
				return yield* reject("transfer_journal_conflict");
			return journal;
		});
		const writePhase = (phase: TransferPhase, initialize = false) =>
			targetBoot.withTransaction(
				Effect.gen(function* () {
					yield* lockBoot(targetBoot);
					const prior = yield* readJournal;
					if (prior === undefined && !initialize) return yield* reject("transfer_journal_conflict");
					const phases: readonly TransferPhase[] = [
						"incomplete",
						"verified",
						"source_boot_retired",
						"source_app_retired",
						"complete",
					];
					if (prior && phases.indexOf(prior.phase) >= phases.indexOf(phase)) return;
					yield* writeSetting(targetBoot, "transfer_journal", JSON.stringify({ binding, phase }));
					if (phase === "complete") yield* writeSetting(targetBoot, "transfer_state", "complete");
				}),
			);
		const sourceState = Effect.gen(function* () {
			const boot = yield* readSettings(sourceBoot);
			const app = yield* identity(sourceApp);
			if (setting(boot, "app_store_id") !== binding.store_id || app.store_id !== binding.store_id)
				return yield* reject("transfer_identity_mismatch");
			const bootMarker = setting(boot, "transferred_to");
			if (
				(bootMarker !== undefined && bootMarker !== marker) ||
				(app.transferred_to !== null && app.transferred_to !== marker)
			)
				return yield* reject("transfer_source_retired");
			const priorState = setting(boot, "transfer_state");
			if (priorState !== undefined && priorState !== "complete") return yield* reject("transfer_recovery_pending");
			if (app.transferred_to !== null && bootMarker === undefined) return yield* reject("transfer_journal_conflict");
			return { bootRetired: bootMarker === marker, appRetired: app.transferred_to === marker };
		});
		let journal = yield* readJournal;
		const source = yield* sourceState;
		if (
			(journal?.phase === "source_boot_retired" && !source.bootRetired) ||
			(journal?.phase === "source_app_retired" && (!source.bootRetired || !source.appRetired))
		)
			return yield* reject("transfer_journal_conflict");
		if (journal?.phase === "complete") {
			yield* checkTargetIdentity;
			if (!source.bootRetired || !source.appRetired) return yield* reject("transfer_journal_conflict");
			return journal;
		}
		const pending = yield* sourceBoot`SELECT pending_id FROM seq WHERE singleton=1`;
		if (pending.length !== 1 || pending[0]?.pending_id !== null) return yield* reject("transfer_recovery_pending");
		const recovery = yield* sourceBoot`SELECT
			CASE WHEN EXISTS(SELECT 1 FROM cutover) THEN 1 ELSE 0 END AS cutover,
			CASE WHEN EXISTS(SELECT 1 FROM db_restore_requests WHERE phase IN ('authorized','restoring','working','rollback') OR lock_id IS NOT NULL) THEN 1 ELSE 0 END AS restore,
			CASE WHEN EXISTS(SELECT 1 FROM source_batches WHERE state='publishing') THEN 1 ELSE 0 END AS source`;
		if (recovery.length !== 1 || recovery[0]?.cutover !== 0 || recovery[0]?.restore !== 0 || recovery[0]?.source !== 0)
			return yield* reject("transfer_recovery_pending");
		if (journal === undefined) {
			if (source.bootRetired || source.appRetired) return yield* reject("transfer_journal_conflict");
			yield* writePhase("incomplete", true);
			journal = { binding, phase: "incomplete" };
		}
		if (journal.phase === "incomplete") {
			if (source.bootRetired || source.appRetired) return yield* reject("transfer_journal_conflict");
			if ((yield* stores.copyAndVerify) !== binding.manifest) return yield* reject("transfer_verification_failed");
			if ((yield* readJournal)?.phase !== "incomplete") return yield* reject("transfer_journal_conflict");
			yield* writePhase("verified");
		}
		if ((yield* stores.reverify) !== binding.manifest) return yield* reject("transfer_verification_failed");
		yield* checkTargetIdentity;
		yield* stores.assertExclusive;
		yield* sourceBoot.withTransaction(
			Effect.gen(function* () {
				yield* lockBoot(sourceBoot);
				const current = yield* readSettings(sourceBoot);
				const prior = setting(current, "transferred_to");
				if (prior !== undefined && prior !== marker) return yield* reject("transfer_source_retired");
				yield* writeSetting(sourceBoot, "transferred_to", marker);
			}),
		);
		if (!(yield* sourceState).bootRetired) return yield* reject("transfer_journal_conflict");
		yield* writePhase("source_boot_retired");
		yield* sourceApp.withTransaction(
			Effect.gen(function* () {
				const rows =
					yield* sourceApp`SELECT store_id,transferred_to FROM store_identity WHERE singleton=1 ${lockRow(sourceApp)}`;
				if (rows.length !== 1) return yield* reject("transfer_identity_mismatch");
				const current = yield* identity(sourceApp);
				if (
					current.store_id !== binding.store_id ||
					(current.transferred_to !== null && current.transferred_to !== marker)
				)
					return yield* reject("transfer_source_retired");
				yield* sourceApp`UPDATE store_identity SET transferred_to=${marker} WHERE singleton=1`;
			}),
		);
		const retired = yield* sourceState;
		if (!retired.bootRetired || !retired.appRetired) return yield* reject("transfer_journal_conflict");
		yield* writePhase("source_app_retired");
		yield* stores.assertExclusive;
		yield* writePhase("complete");
		return { binding, phase: "complete" } satisfies TransferJournal;
	});
