import { tableShape } from "@comms/storage/remote-migrations";
import { on } from "@comms/storage/dialect";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";

export const migrationIntentShape = (sql: SqlClient.SqlClient) =>
	tableShape(
		sql,
		"kernel_migration_intent",
		[
			{ name: "singleton", type: "int", nullable: false, default: null, expression: "" },
			...[
				{ name: "scope", length: 255 },
				{ name: "name", length: 255 },
				{ name: "epoch", length: 128 },
			].map((column) => ({
				...column,
				type: "varchar",
				nullable: false,
				default: null,
				expression: "",
				collation: "utf8mb4_0900_bin",
			})),
		],
		["singleton"],
		{ checks: ["(`singleton` = 1)"], foreignKeys: [] },
	).pipe(Effect.mapError(() => new KernelError({ code: "migration_recovery_required" })));

/** An unfinished MySQL DDL operation is not replayable merely because its receipt is absent. */
export const assertNoPendingMigration = (sql: SqlClient.SqlClient) =>
	on<Effect.Effect<void, KernelError | SqlError.SqlError>>(sql, {
		sqlite: () => Effect.void,
		pg: () => Effect.void,
		mysql: () =>
			Effect.gen(function* () {
				if (!(yield* migrationIntentShape(sql))) return yield* new KernelError({ code: "migration_recovery_required" });
				if ((yield* sql`SELECT singleton FROM kernel_migration_intent`).length)
					return yield* new KernelError({ code: "migration_recovery_required" });
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
		if (!(yield* migrationIntentShape(sql))) return yield* new KernelError({ code: "migration_recovery_required" });
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, epoch);
				const pending =
					yield* sql`SELECT singleton FROM kernel_migration_intent WHERE singleton=1 AND scope=${scope} AND name=${name} AND epoch=${epoch} FOR UPDATE`;
				if (pending.length !== 1) return yield* new KernelError({ code: "migration_recovery_required" });
				yield* receipt;
				yield* sql`DELETE FROM kernel_migration_intent WHERE singleton=1`;
			}),
		);
		return result;
	});
