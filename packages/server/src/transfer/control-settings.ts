import { on } from "@comms/storage/dialect";
import { TransferRejected, type TransferSelection } from "@comms/storage/store-transfer-schema";
import { makeTransferDigest } from "@comms/storage/transfer-values";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

const Row = Schema.Struct({ key: Schema.String, value: Schema.String });
type Row = typeof Row.Type;
const rows = Schema.decodeUnknownEffect(Schema.Array(Row));
const invalid = () => new TransferRejected({ code: "transfer_recovery_pending" });
const mismatch = () => new TransferRejected({ code: "transfer_verification_failed" });
const authority = [
	"app_store_adoption",
	"app_store_id",
	"app_store_initialized",
	"app_store_database",
	"app_store_layout",
] as const;
const controls = [
	"transfer_state",
	"transfer_journal",
	"transfer_prepare",
	"transfer_kernel",
	"transferred_to",
	"app_store_schema",
] as const;
export const isTransferControl = (key: string) => controls.some((name) => name === key);
const json = (value: string) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.mapError(invalid));
const object = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Control journals belong to the selected target. Old authority remains inert history. */
const project = (row: Row, selection: TransferSelection, initializedAt: number) =>
	Effect.gen(function* () {
		const prefix = `transfer-history:${selection.transfer_id}:`;
		if (row.key.startsWith(prefix)) return yield* invalid();
		if (row.key === "transferred_to") return [];
		if (row.key === "app_store_id" && row.value !== selection.store_id) return yield* invalid();
		if (row.key === "sqlite_copy" || row.key.startsWith("source-revert:")) return yield* invalid();
		if (row.key === "app_store_layout" && row.value !== "ready") return yield* invalid();
		if (row.key === "transfer_state" && row.value !== "complete") return yield* invalid();
		if (row.key === "app_store_adoption" || row.key === "app_store_schema" || row.key.startsWith("remote_database:")) {
			const parsed = yield* json(row.value);
			if (!object(parsed)) return yield* invalid();
			if (row.key === "app_store_adoption" && parsed.phase !== "ready") return yield* invalid();
			if (
				row.key === "app_store_schema" &&
				(parsed.active !== null || !Array.isArray(parsed.operations) || parsed.next !== parsed.operations.length)
			)
				return yield* invalid();
			if (
				row.key === "app_store_adoption" &&
				(parsed.store_id !== selection.store_id || parsed.initialized_at !== initializedAt)
			)
				return yield* invalid();
			if (row.key.startsWith("remote_database:") && parsed.phase !== "closed") return yield* invalid();
		}
		if (row.key.startsWith("source-revert-result:")) {
			const receipt = yield* Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						selector: Schema.String,
						page_batch: Schema.NullOr(Schema.String),
						outcome: Schema.Struct({ status: Schema.Int, body: Schema.Json }),
						created_at: Schema.optionalKey(Schema.Int),
						completed_at: Schema.optionalKey(Schema.NullOr(Schema.Int)),
					}),
				),
			)(row.value).pipe(Effect.mapError(invalid));
			if (receipt.outcome.status < 100 || receipt.outcome.status > 599) return yield* invalid();
		}
		return [
			{
				key:
					authority.some((key) => key === row.key) ||
					isTransferControl(row.key) ||
					row.key.startsWith("remote_database:")
						? `${prefix}${row.key}`
						: row.key,
				value: row.value,
			},
		];
	});

const scan = <E, R>(sql: SqlClient, consume: (row: Row) => Effect.Effect<void, E, R>) =>
	Effect.gen(function* () {
		const order = on(sql, {
			sqlite: () => sql`${sql("key")} COLLATE BINARY`,
			pg: () => sql`${sql("key")} COLLATE "C"`,
			mysql: () => sql`BINARY ${sql("key")}`,
		});
		let offset = 0;
		while (true) {
			const batch =
				yield* sql`SELECT ${sql("key")},value FROM settings ORDER BY ${order} LIMIT 1 OFFSET ${offset}`.pipe(
					Effect.flatMap(rows),
				);
			if (!batch[0]) return;
			yield* consume(batch[0]);
			offset++;
		}
	});

/** Caller holds all four offline owners throughout preparation, copy and verification. */
export const prepareControlSettings = (
	source: SqlClient,
	target: SqlClient,
	selection: TransferSelection,
	initializedAt: number,
) =>
	Effect.gen(function* () {
		const adoption =
			selection.target.engine === "sqlite"
				? {
						store_id: selection.store_id,
						initialized_at: initializedAt,
						filename: selection.target.app,
						mode: "fresh",
						phase: "ready",
					}
				: {
						store_id: selection.store_id,
						initialized_at: initializedAt,
						engine: selection.target.engine === "pg" ? "postgres" : "mysql",
						database: selection.target.app,
						phase: "ready",
					};
		if (selection.target.engine === "sqlite" && selection.target.app !== `${selection.data_directory}/store/comms.db`)
			return yield* invalid();
		const rebuilt: readonly Row[] = [
			{ key: "app_store_adoption", value: JSON.stringify(adoption) },
			{ key: "app_store_id", value: selection.store_id },
			{ key: "app_store_initialized", value: "1" },
			...(selection.target.engine === "sqlite"
				? [{ key: "app_store_layout", value: "ready" }]
				: [{ key: "app_store_database", value: selection.target.app }]),
		];
		const expected = <E, R>(consume: (row: Row) => Effect.Effect<void, E, R>) =>
			Effect.gen(function* () {
				yield* scan(source, (row) =>
					Effect.gen(function* () {
						for (const value of yield* project(row, selection, initializedAt)) {
							if (
								(selection.target.engine === "mysql" && [...value.key].length > 128) ||
								(selection.target.engine === "pg" && (value.key.includes("\0") || value.value.includes("\0")))
							)
								return yield* mismatch();
							yield* consume(value);
						}
					}),
				);
				for (const row of rebuilt) yield* consume(row);
			});
		const digest = yield* makeTransferDigest;
		let count = 0;
		yield* expected((row) =>
			digest
				.append([
					{ kind: "text", value: row.key },
					{ kind: "text", value: row.value },
				])
				.pipe(
					Effect.tap(
						Effect.sync(() => {
							count++;
						}),
					),
				),
		);
		const manifest = { rows: count, digest: yield* digest.finish };
		const read = (key: string) =>
			target`SELECT ${target("key")},value FROM settings WHERE ${target("key")}=${key}`.pipe(Effect.flatMap(rows));
		const verify = Effect.gen(function* () {
			const check = yield* makeTransferDigest;
			let found = 0;
			yield* expected((row) =>
				Effect.gen(function* () {
					const actual = yield* read(row.key);
					if (actual.length !== 1 || actual[0]?.key !== row.key || actual[0]?.value !== row.value)
						return yield* mismatch();
					yield* check.append([
						{ kind: "text", value: row.key },
						{ kind: "text", value: row.value },
					]);
				}),
			);
			yield* scan(target, (row) =>
				Effect.sync(() => {
					if (!isTransferControl(row.key)) found++;
				}),
			);
			if (found !== manifest.rows || (yield* check.finish) !== manifest.digest) return yield* mismatch();
		});
		const copy = expected((row) =>
			target.withTransaction(
				Effect.gen(function* () {
					yield* on(target, {
						sqlite: () => Effect.void,
						pg: () => target`SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE`.pipe(Effect.asVoid),
						mysql: () => target`SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE`.pipe(Effect.asVoid),
					});
					const existing = yield* read(row.key);
					if (existing.length > 1 || (existing[0] && (existing[0].key !== row.key || existing[0].value !== row.value)))
						return yield* mismatch();
					if (existing.length === 0)
						yield* target`INSERT INTO settings(${target("key")},value) VALUES(${row.key},${row.value})`;
				}),
			),
		);
		return { manifest, copy, verify };
	});
