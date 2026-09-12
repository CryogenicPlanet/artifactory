import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";

/** An unfinished MySQL DDL operation is not replayable merely because its receipt is absent. */
export const assertNoPendingMigration = (sql: SqlClient.SqlClient) =>
	on<Effect.Effect<void, KernelError | SqlError.SqlError>>(sql, {
		sqlite: () => Effect.void,
		pg: () => Effect.void,
		mysql: () =>
			Effect.gen(function* () {
				if ((yield* sql`SELECT singleton FROM kernel_migration_intent`).length)
					return yield* new KernelError({ code: "extension_migration_conflict" });
			}),
	});

/** The caller validates its input first. Failure or interruption deliberately retains the intent. */
export const mysqlMigration = <A, E, R, E2, R2>(
	sql: SqlClient.SqlClient,
	epoch: string,
	scope: string,
	name: string,
	operation: Effect.Effect<A, E, R>,
	receipt: Effect.Effect<void, E2, R2>,
) =>
	Effect.gen(function* () {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				yield* assertNoPendingMigration(sql);
				yield* sql`INSERT INTO kernel_migration_intent(singleton,scope,name,epoch) VALUES(1,${scope},${name},${epoch})`;
			}),
		);
		const result = yield* operation;
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				const pending =
					yield* sql`SELECT singleton FROM kernel_migration_intent WHERE singleton=1 AND scope=${scope} AND name=${name} AND epoch=${epoch} FOR UPDATE`;
				if (pending.length !== 1) return yield* new KernelError({ code: "extension_migration_conflict" });
				yield* receipt;
				yield* sql`DELETE FROM kernel_migration_intent WHERE singleton=1`;
			}),
		);
		return result;
	});
