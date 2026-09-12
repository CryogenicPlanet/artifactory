import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
export { tableShape, indexShape, type ColumnShape } from "./schema-shape.ts";

export class RemoteMigrationError extends Schema.TaggedError<RemoteMigrationError>()("RemoteMigrationError", {
	code: Schema.Literals([
		"migration_ledger_invalid",
		"migration_ledger_too_new",
		"migration_lock_unavailable",
		"migration_postcondition_failed",
		"migration_unowned_object",
	]),
	ledger: Schema.String,
}) {}
export interface RemoteOperation<E = never, R = never> {
	readonly name: string;
	readonly run: Effect.Effect<void, E, R>;
	readonly postcondition: Effect.Effect<boolean, E, R>;
}
export interface RemoteStep<E = never, R = never> {
	readonly id: number;
	readonly name: string;
	readonly operations: ReadonlyArray<RemoteOperation<E, R>>;
}
const rows = Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String }));
const intentRows = Schema.Array(
	Schema.Struct({
		migration_id: Schema.Int,
		name: Schema.String,
		operation: Schema.Int,
		active: Schema.NullOr(Schema.String),
	}),
);

/** Remote stores start with their own ledger, never a SQLite version stamp.
 * MySQL records each owned DDL boundary because DDL commits independently of transactions. */
export const remoteMigrate = <E, R>(
	sql: SqlClient,
	ledger: "boot_migrations" | "core_migrations",
	steps: ReadonlyArray<RemoteStep<E, R>>,
	beforeOperation: Effect.Effect<void, E, R> = Effect.void,
) => {
	const invalid = () => new RemoteMigrationError({ code: "migration_ledger_invalid", ledger });
	const initialize = Effect.gen(function* () {
		if (
			!steps.length ||
			steps.some(
				(step, index) =>
					step.id !== index + 1 ||
					!step.name ||
					new Set(step.operations.map((op) => op.name)).size !== step.operations.length ||
					step.operations.some((op) => !op.name),
			)
		)
			return yield* invalid();
		yield* on(sql, {
			sqlite: () => {
				throw new Error("Remote migrations require PostgreSQL or MySQL");
			},
			pg: () =>
				sql`CREATE TABLE IF NOT EXISTS ${sql(ledger)} (migration_id integer PRIMARY KEY, name varchar(255) NOT NULL, created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
			mysql: () =>
				sql`CREATE TABLE IF NOT EXISTS ${sql(ledger)} (migration_id integer PRIMARY KEY, name varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		});
		const applied = yield* sql`SELECT migration_id,name FROM ${sql(ledger)} ORDER BY migration_id`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(rows)),
		);
		if (applied.some((row) => row.migration_id > steps.length))
			return yield* new RemoteMigrationError({ code: "migration_ledger_too_new", ledger });
		if (applied.some((row, index) => row.migration_id !== index + 1 || row.name !== steps[index]?.name))
			return yield* invalid();
		return applied.length;
	});
	const pg = sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext(${ledger}))`;
			yield* beforeOperation;
			const applied = yield* initialize;
			for (const step of steps.slice(applied)) {
				for (const operation of step.operations) {
					yield* beforeOperation;
					if (yield* operation.postcondition)
						return yield* new RemoteMigrationError({ code: "migration_unowned_object", ledger });
					yield* operation.run;
					if (!(yield* operation.postcondition))
						return yield* new RemoteMigrationError({ code: "migration_postcondition_failed", ledger });
				}
				yield* beforeOperation;
				yield* sql`INSERT INTO ${sql(ledger)} (migration_id,name) VALUES (${step.id},${step.name})`;
			}
		}),
	);
	const mysql = Effect.scoped(
		Effect.gen(function* () {
			const connection = yield* sql.reserve;
			const intent = `${ledger}_intent`;
			const work = Effect.gen(function* () {
				const locked = yield* sql`SELECT GET_LOCK(SHA2(CONCAT(DATABASE(),':',${ledger}),256),30) AS acquired`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ acquired: Schema.NullOr(Schema.Int) }))),
					),
				);
				if (locked[0]?.acquired !== 1)
					return yield* new RemoteMigrationError({ code: "migration_lock_unavailable", ledger });
				yield* Effect.addFinalizer(() =>
					sql`SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(),':',${ledger}),256))`.pipe(Effect.orDie),
				);
				yield* beforeOperation;
				const applied = yield* initialize;
				yield* sql`CREATE TABLE IF NOT EXISTS ${sql(intent)} (singleton integer PRIMARY KEY CHECK(singleton=1),migration_id integer NOT NULL,name varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,operation integer NOT NULL,active varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin)`;
				const pending =
					yield* sql`SELECT migration_id,name,operation,active FROM ${sql(intent)} WHERE singleton=1`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(intentRows)),
					);
				let current = pending[0];
				if (current) {
					const step = steps[current.migration_id - 1];
					if (
						!step ||
						current.name !== step.name ||
						current.operation < 0 ||
						current.operation > step.operations.length ||
						current.migration_id < applied ||
						current.migration_id > applied + 1 ||
						(current.active !== null && current.active !== step.operations[current.operation]?.name)
					)
						return yield* invalid();
					if (current.migration_id === applied) {
						if (current.operation !== step.operations.length || current.active !== null) return yield* invalid();
						yield* sql`DELETE FROM ${sql(intent)} WHERE singleton=1`;
						current = undefined;
					}
				}
				for (const step of steps.slice(applied)) {
					if (!current) {
						yield* sql`INSERT INTO ${sql(intent)} (singleton,migration_id,name,operation,active) VALUES (1,${step.id},${step.name},0,NULL)`;
						current = { migration_id: step.id, name: step.name, operation: 0, active: null };
					}
					for (let index = current.operation; index < step.operations.length; index++) {
						const operation = step.operations[index];
						if (!operation) return yield* invalid();
						yield* beforeOperation;
						const complete = yield* operation.postcondition;
						if (current.active === null) {
							if (complete) return yield* new RemoteMigrationError({ code: "migration_unowned_object", ledger });
							yield* sql`UPDATE ${sql(intent)} SET active=${operation.name} WHERE singleton=1`;
						}
						if (!complete) yield* operation.run;
						if (!(yield* operation.postcondition))
							return yield* new RemoteMigrationError({ code: "migration_postcondition_failed", ledger });
						yield* sql`UPDATE ${sql(intent)} SET operation=${index + 1},active=NULL WHERE singleton=1`;
						current = { ...current, operation: index + 1, active: null };
					}
					yield* beforeOperation;
					yield* sql`INSERT INTO ${sql(ledger)} (migration_id,name) VALUES (${step.id},${step.name})`;
					yield* sql`DELETE FROM ${sql(intent)} WHERE singleton=1`;
					current = undefined;
				}
			});
			yield* work.pipe(Effect.provideService(sql.transactionService, [connection, -1]));
		}),
	);
	return on(sql, {
		sqlite: () => {
			throw new Error("Remote migrations require PostgreSQL or MySQL");
		},
		pg: () => pg.pipe(Effect.asVoid),
		mysql: () => mysql,
	});
};
