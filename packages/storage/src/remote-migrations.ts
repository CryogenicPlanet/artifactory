import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "./dialect.ts";
import { tableShape } from "./schema-shape.ts";
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
	/** Idempotent data reconciliation may already satisfy its content postcondition. DDL retains ownership refusal. */
	readonly kind?: "data";
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
		singleton: Schema.Int,
		migration_id: Schema.Int,
		name: Schema.String,
		operation: Schema.Int,
		active: Schema.NullOr(Schema.String),
	}),
);

/** Remote stores start with their own ledger, never a SQLite version stamp.
 * MySQL records each owned DDL boundary because DDL commits independently of transactions. */
export const remoteMigrate = <E, R, E2 = never, R2 = never>(
	sql: SqlClient,
	ledger: "boot_migrations" | "core_migrations",
	steps: ReadonlyArray<RemoteStep<E, R>>,
	beforeOperation: Effect.Effect<void, E2, R2> = Effect.void,
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
				sql`CREATE TABLE IF NOT EXISTS ${sql(ledger)} (migration_id integer PRIMARY KEY, name varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
		});
		yield* tableShape(
			sql,
			ledger,
			[
				{
					name: "migration_id",
					type: on(sql, { sqlite: () => "integer", pg: () => "integer", mysql: () => "int" }),
					nullable: false,
				},
				{
					name: "name",
					type: on(sql, { sqlite: () => "varchar", pg: () => "character varying", mysql: () => "varchar" }),
					nullable: false,
					length: 255,
				},
				{
					name: "created_at",
					type: on(sql, {
						sqlite: () => "timestamp",
						pg: () => "timestamp without time zone",
						mysql: () => "timestamp",
					}),
					nullable: false,
				},
			],
			["migration_id"],
		);
		const applied = yield* sql`SELECT migration_id,name FROM ${sql(ledger)} ORDER BY migration_id`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(rows)),
		);
		if (applied.some((row) => row.migration_id > steps.length))
			return yield* new RemoteMigrationError({ code: "migration_ledger_too_new", ledger });
		if (applied.some((row, index) => row.migration_id !== index + 1 || row.name !== steps[index]?.name))
			return yield* invalid();
		return applied.length;
	});
	const runOperation = (operation: RemoteOperation<E, R>) =>
		operation.kind === "data"
			? sql.withTransaction(
					Effect.gen(function* () {
						yield* beforeOperation;
						yield* operation.run;
						if (!(yield* operation.postcondition))
							return yield* new RemoteMigrationError({ code: "migration_postcondition_failed", ledger });
					}),
				)
			: operation.run;
	const pg = sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext(${ledger}))`;
			yield* beforeOperation;
			const applied = yield* initialize;
			for (const step of steps.slice(applied)) {
				for (const operation of step.operations) {
					yield* beforeOperation;
					const complete = yield* operation.postcondition;
					if (complete && operation.kind !== "data")
						return yield* new RemoteMigrationError({ code: "migration_unowned_object", ledger });
					if (!complete) yield* runOperation(operation);
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
				const locked = yield* Effect.acquireRelease(
					sql`SELECT GET_LOCK(SHA2(CONCAT(DATABASE(),':',${ledger}),256),30) AS acquired`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ acquired: Schema.NullOr(Schema.Int) }))),
						),
					),
					() => sql`SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(),':',${ledger}),256))`.pipe(Effect.orDie),
				);
				if (locked[0]?.acquired !== 1)
					return yield* new RemoteMigrationError({ code: "migration_lock_unavailable", ledger });

				yield* beforeOperation;
				const applied = yield* initialize;
				yield* sql`CREATE TABLE IF NOT EXISTS ${sql(intent)} (singleton integer PRIMARY KEY CHECK(singleton=1),migration_id integer NOT NULL,name varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,operation integer NOT NULL,active varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin) ENGINE=InnoDB`;
				yield* tableShape(
					sql,
					intent,
					[
						{ name: "singleton", type: "int", nullable: false },
						{ name: "migration_id", type: "int", nullable: false },
						{ name: "name", type: "varchar", nullable: false, length: 255, collation: "utf8mb4_bin" },
						{ name: "operation", type: "int", nullable: false },
						{ name: "active", type: "varchar", nullable: true, length: 255, collation: "utf8mb4_bin" },
					],
					["singleton"],
					{ checks: ["(`singleton` = 1)"] },
				);
				const pending = yield* sql`SELECT singleton,migration_id,name,operation,active FROM ${sql(intent)}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(intentRows)),
				);
				if (pending.length > 1 || pending.some((row) => row.singleton !== 1)) return yield* invalid();
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
						current = { singleton: 1, migration_id: step.id, name: step.name, operation: 0, active: null };
					}
					for (let index = current.operation; index < step.operations.length; index++) {
						const operation = step.operations[index];
						if (!operation) return yield* invalid();
						yield* beforeOperation;
						const complete = yield* operation.postcondition;
						if (current.active === null) {
							if (complete && operation.kind !== "data")
								return yield* new RemoteMigrationError({ code: "migration_unowned_object", ledger });
							yield* sql`UPDATE ${sql(intent)} SET active=${operation.name} WHERE singleton=1`;
						}
						if (!complete) yield* runOperation(operation);
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
			// Reserve one connection without an open transaction: depth -1 makes any nested
			// withTransaction begin/commit on this lease instead of creating a savepoint.
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
