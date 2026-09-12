import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { TransferCopyError, type TransferTableManifest, type TransferTablePlan } from "./transfer-plan.ts";

const invalid = () => new TransferCopyError({ code: "transfer_plan_invalid" });
const sequenceRows = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		minimum: Schema.String,
		maximum: Schema.String,
		increment: Schema.String,
		cycle: Schema.Boolean,
	}),
);

/** Capture and validate actual owned generators before writing. This carries the maximum retained
 * value, not a source generator's deleted-row history. SQLite rowid insertion maintains its generator.
 */
export const prepareTransferIdentities = (sql: SqlClient, plan: TransferTablePlan, manifest: TransferTableManifest) =>
	Effect.gen(function* () {
		const repairs: { readonly name: string; readonly next: bigint }[] = [];
		for (const identity of manifest.identities) {
			if (!plan.identities.includes(identity.column)) return yield* invalid();
			const maximum = identity.maximum === null ? 0n : BigInt(identity.maximum);
			const next = maximum < 1n ? 1n : maximum + 1n;
			yield* on<Effect.Effect<void, SqlError | Schema.SchemaError | TransferCopyError>>(sql, {
				sqlite: () => Effect.void,
				mysql: () =>
					Effect.sync(() => {
						repairs.push({ name: identity.column, next });
					}),
				pg: () =>
					Effect.gen(function* () {
						// pg_get_serial_sequence accepts a parsed SQL identifier as text, not a bare table name.
						const table = `"public"."${plan.name.replaceAll('"', '""')}"`;
						const rows =
							yield* sql`SELECT c.oid::regclass::text AS name,s.seqmin::text AS minimum,s.seqmax::text AS maximum,s.seqincrement::text AS increment,s.seqcycle AS cycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.oid=pg_get_serial_sequence(${table},${identity.column})::regclass`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(sequenceRows)),
							);
						const sequence = rows[0];
						if (
							rows.length !== 1 ||
							!sequence ||
							sequence.increment !== "1" ||
							sequence.cycle ||
							next < BigInt(sequence.minimum) ||
							next > BigInt(sequence.maximum)
						)
							return yield* invalid();
						repairs.push({ name: sequence.name, next });
					}),
			});
		}
		return Effect.gen(function* () {
			for (const repair of repairs)
				yield* on<Effect.Effect<void, SqlError | Schema.SchemaError | TransferCopyError>>(sql, {
					sqlite: () => Effect.void,
					pg: () =>
						sql`SELECT setval(${repair.name}::regclass,${repair.next.toString()}::bigint,false)::text`.pipe(
							Effect.asVoid,
						),
					// MySQL grammar requires a literal here; next is a validated bigint, never user SQL.
					mysql: () =>
						sql`ALTER TABLE ${sql(plan.name)} AUTO_INCREMENT=${sql.literal(repair.next.toString())}`.pipe(
							Effect.asVoid,
						),
				});
		});
	});
