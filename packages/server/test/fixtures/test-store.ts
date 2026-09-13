import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, Exit, FileSystem, Layer, Redacted, Schema, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "@comms/storage/dialect";
import { advisoryClientLayer, directClientLayer } from "@comms/storage/remote-client";

const settings = Schema.fromJsonString(
	Schema.Struct({
		engine: Schema.Literals(["pg", "mysql"]),
		host: Schema.String,
		port: Schema.Int,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);

/** Test-only scratch store. Remote callers supply an exclusively allocated empty database;
 * memory SQLite is deliberately outside deployment descriptor grammar. Scope owns pool and tables. */
export const testStore = (options: {
	readonly engine: "sqlite" | "pglite" | "pg" | "mysql";
	readonly config: string | undefined;
	readonly database: string;
	readonly tables: readonly string[];
}) =>
	Effect.gen(function* () {
		const client = yield* Effect.gen(function* () {
			if (options.engine === "sqlite")
				return { sql: yield* SqliteClient.make({ filename: ":memory:" }), cleanup: undefined };
			if (options.engine === "pglite")
				return {
					sql: yield* PgliteClient.make({
						// Match remote raw JSON and checked int8 decoding without global parser mutation.
						parsers: {
							114: (value) => value,
							3802: (value) => value,
							20: (value) => {
								const number = Number(value);
								if (!Number.isSafeInteger(number)) throw new Error("Test store integer out of range");
								return number;
							},
						},
					}),
					cleanup: undefined,
				};
			if (!options.config) return yield* Effect.fail(new Error("Missing test store configuration"));
			const fs = yield* FileSystem.FileSystem;
			const config = yield* fs.readFileString(options.config).pipe(Effect.flatMap(Schema.decodeEffect(settings)));
			if (config.engine !== options.engine || config.database !== options.database)
				return yield* Effect.fail(new Error("Dedicated test store required"));
			const connection = { ...config, password: Redacted.make(config.password), tls: false };
			const writerScope = yield* Scope.fork(yield* Effect.scope);
			const sql = Context.get(
				yield* Scope.provide(Layer.build(advisoryClientLayer({ connection })), writerScope),
				SqlClient,
			);
			return {
				sql,
				cleanup: Effect.gen(function* () {
					// A fault-injection test may leave the pinned writer unusable or its transaction open.
					// Close it before an independent connection touches the validated disposable tables.
					yield* Scope.close(writerScope, Exit.void);
					const inspector = Context.get(yield* Layer.build(directClientLayer({ connection })), SqlClient);
					yield* Effect.forEach(options.tables, (table) => inspector`DROP TABLE IF EXISTS ${inspector(table)}`, {
						discard: true,
					});
				}).pipe(Effect.scoped),
			};
		});
		const { sql } = client;
		const existing = yield* on(sql, {
			sqlite: () => sql`SELECT name FROM sqlite_schema WHERE type='table'`,
			pg: () => sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()`,
			mysql: () => sql`SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()`,
		});
		if (existing.length) return yield* Effect.fail(new Error("Test store must be empty"));
		// Install only after proving the dedicated scratch is empty; never reset a pre-existing store.
		yield* Effect.addFinalizer(() =>
			(
				client.cleanup ??
				Effect.forEach(options.tables, (table) => sql`DROP TABLE IF EXISTS ${sql(table)}`, { discard: true })
			).pipe(Effect.orDie),
		);
		return sql;
	});
