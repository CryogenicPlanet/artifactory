import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on, readTransaction } from "./dialect.ts";
import { transferPacketLimit } from "./transfer-packet.ts";
import { prepareTransferIdentities } from "./transfer-identity.ts";
import {
	TransferCopyError,
	type TransferEngine,
	type TransferTableManifest,
	type TransferTablePlan,
} from "./transfer-plan.ts";
import { decodeTransferRow, transferInsert, transferOrder, validateTransferPlan } from "./transfer-projection.ts";
import type { TransferTable } from "./transfer-schema.ts";
import { makeTransferDigest, type TransferValue } from "./transfer-values.ts";
import { readTransferRows } from "./transfer-reader.ts";
import { validateTransferTargetValues } from "./transfer-target-values.ts";

export {
	TransferCopyError,
	type TransferEngine,
	type TransferTableManifest,
	type TransferTablePlan,
} from "./transfer-plan.ts";
const failure = (code: TransferCopyError["code"]) => new TransferCopyError({ code });
const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError((error) => (error instanceof TransferCopyError ? error : failure("transfer_query_failed"))),
	);

const scan = <E, R>(
	sql: SqlClient,
	plan: TransferTablePlan,
	target: TransferTable,
	engine: TransferEngine,
	consume: (rows: readonly (readonly TransferValue[])[]) => Effect.Effect<void, E, R>,
) =>
	readTransaction(
		sql,
		Effect.gen(function* () {
			yield* validateTransferPlan(plan, target, engine);
			const order = transferOrder(sql, plan);
			const duplicate = yield* sql`SELECT 1 FROM ${sql(plan.name)} GROUP BY ${order} HAVING COUNT(*)>1 LIMIT 1`;
			if (duplicate.length) return yield* failure("transfer_plan_invalid");
			const digest = yield* makeTransferDigest;
			// Bind table identity, projection order, kinds and key into the content commitment.
			yield* digest.append([{ kind: "text", value: JSON.stringify(plan) }]);
			const maxima = new Map<string, bigint>();
			let count = 0;
			yield* readTransferRows(sql, plan, (entry) =>
				Effect.gen(function* () {
					const row = yield* decodeTransferRow(entry, plan, target, engine);
					yield* digest.append(row);
					for (const name of plan.identities) {
						const value = row[plan.columns.findIndex((column) => column.name === name)];
						if (value?.kind !== "integer") return yield* failure("transfer_value_invalid");
						const integer = BigInt(value.value);
						const previous = maxima.get(name);
						if (previous === undefined || integer > previous) maxima.set(name, integer);
					}
					count++;
					if (!Number.isSafeInteger(count)) return yield* failure("transfer_value_invalid");
					yield* consume([row]);
				}),
			);
			return {
				rows: count,
				digest: yield* digest.finish,
				identities: plan.identities.map((column) => ({ column, maximum: maxima.get(column)?.toString() ?? null })),
			} satisfies TransferTableManifest;
		}),
	);

/** A stable, bounded scan. Caller holds both stores offline, validates inventories and scans ALL
 * selected tables before beginning ANY copy. The target engine/shape enforce destination ranges.
 */
export const scanTransferTable = (
	sql: SqlClient,
	plan: TransferTablePlan,
	target: TransferTable,
	engine: TransferEngine,
) => safe(scan(sql, plan, target, engine, () => Effect.void));

/** Full read-only preflight including destination JSON representation and owned generator limits.
 * Run this for every selected table before copying any table. No destination objects are created.
 */
export const prepareTransferTable = (
	source: SqlClient,
	target: SqlClient,
	plan: TransferTablePlan,
	shape: TransferTable,
) =>
	safe(
		Effect.gen(function* () {
			const engine = on(target, {
				sqlite: () => "sqlite" as const,
				pg: () => "pg" as const,
				mysql: () => "mysql" as const,
			});
			const packetLimit = yield* transferPacketLimit(target);
			const manifest = yield* scan(source, plan, shape, engine, (rows) =>
				validateTransferTargetValues(target, plan, rows, packetLimit),
			);
			yield* prepareTransferIdentities(target, plan, manifest).pipe(Effect.asVoid);
			return manifest;
		}),
	);

const matches = (left: TransferTableManifest, right: TransferTableManifest) =>
	left.rows === right.rows &&
	left.digest === right.digest &&
	JSON.stringify(left.identities) === JSON.stringify(right.identities);

/** No ownership, publication, retries or conflict suppression. Destination must be empty. A failed
 * transfer remains owned by the caller's incomplete journal; this operation never activates it.
 */
export const copyTransferTable = (
	source: SqlClient,
	target: SqlClient,
	plan: TransferTablePlan,
	shape: TransferTable,
	expected: TransferTableManifest,
) =>
	safe(
		Effect.gen(function* () {
			const engine = on(target, {
				sqlite: () => "sqlite" as const,
				pg: () => "pg" as const,
				mysql: () => "mysql" as const,
			});
			const prepared = yield* prepareTransferTable(source, target, plan, shape);
			if (!matches(prepared, expected)) return yield* failure("transfer_digest_mismatch");
			const repair = yield* prepareTransferIdentities(target, plan, prepared);
			const verified = yield* target.withTransaction(
				Effect.gen(function* () {
					if ((yield* target`SELECT 1 FROM ${target(plan.name)} LIMIT 1`).length)
						return yield* failure("transfer_target_not_empty");
					const copied = yield* scan(source, plan, shape, engine, (rows) =>
						Effect.gen(function* () {
							// Each bounded read batch stays inside one destination transaction. Individual inserts keep
							// parameter counts bounded even for wide custom tables and preserve immediate FK checks.
							for (const row of rows) {
								yield* transferInsert(target, plan, row);
							}
						}),
					);
					if (!matches(copied, expected)) return yield* failure("transfer_digest_mismatch");
					const verified = yield* scanTransferTable(target, plan, shape, engine);
					if (!matches(verified, expected)) return yield* failure("transfer_digest_mismatch");
					return verified;
				}),
			);
			// MySQL ALTER TABLE commits implicitly, so generator publication follows verified data commit.
			// A failure here leaves the coordinator's target incomplete and cannot authorize activation.
			yield* repair;
			return verified;
		}),
	);
