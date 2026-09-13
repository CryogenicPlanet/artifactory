import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { on } from "@comms/storage/dialect";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { RemoteInspector, remoteInspectorLayer } from "@comms/storage/remote-inspector";

/** Private, scope-owned scratch databases. These are not deployment descriptors. */
export const memoryStore = () => SqliteClient.make({ filename: ":memory:" });
export const memoryStoreLayer = () => SqliteClient.layer({ filename: ":memory:" });

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
		const sql = yield* Effect.gen(function* () {
			if (options.engine === "sqlite") return yield* memoryStore();
			if (options.engine === "pglite")
				return yield* PgliteClient.make({
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
				});
			if (!options.config) return yield* Effect.fail(new Error("Missing test store configuration"));
			const fs = yield* FileSystem.FileSystem;
			const config = yield* fs.readFileString(options.config).pipe(Effect.flatMap(Schema.decodeEffect(settings)));
			if (config.engine !== options.engine || config.database !== options.database)
				return yield* Effect.fail(new Error("Dedicated test store required"));
			const connection = { ...config, password: Redacted.make(config.password), tls: false };
			const attempt = "d3".repeat(32);
			const inspector = Context.get(yield* Layer.build(remoteInspectorLayer({ connection, attempt })), RemoteInspector);
			return Context.get(
				yield* Layer.build(
					remoteClientLayer({ connection, attempt, register: () => Effect.void }).pipe(
						Layer.provide(Layer.succeed(RemoteInspector, inspector)),
					),
				),
				SqlClient,
			);
		});
		const existing = yield* on(sql, {
			sqlite: () => sql`SELECT name FROM sqlite_schema WHERE type='table'`,
			pg: () => sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()`,
			mysql: () => sql`SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()`,
		});
		if (existing.length) return yield* Effect.fail(new Error("Test store must be empty"));
		// Install only after proving the dedicated scratch is empty; never reset a pre-existing store.
		yield* Effect.addFinalizer(() =>
			Effect.forEach(options.tables, (table) => sql`DROP TABLE IF EXISTS ${sql(table)}`, { discard: true }).pipe(
				Effect.orDie,
			),
		);
		return sql;
	});
