import { remoteMigrate, indexShape, RemoteMigrationError } from "@comms/storage/remote-migrations";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteBootEvent } from "./remote-boot-event-schema.ts";
import { remoteBootAuth } from "./remote-boot-auth-schema.ts";
import { remoteBootRuntime } from "./remote-boot-runtime-schema.ts";
import { remoteBootSource } from "./remote-boot-source-schema.ts";

/** These histories have never existed remotely: introduce final table shapes, retaining every logical ID. */
export const initializeRemoteBootSchema = (sql: SqlClient, engine: "pg" | "mysql") =>
	Effect.gen(function* () {
		// convert_to is STABLE. The generated hash uses immutable escape decoding of UTF-8 text bytes.
		if (engine === "pg") {
			const encoding = yield* sql`SELECT current_setting('server_encoding') AS encoding`;
			if (encoding[0]?.encoding !== "UTF8")
				return yield* new RemoteMigrationError({ code: "migration_postcondition_failed", ledger: "boot_migrations" });
		}

		const tables = [
			...remoteBootAuth(sql, engine),
			...remoteBootEvent(sql, engine),
			...remoteBootRuntime(sql, engine),
			...remoteBootSource(sql, engine),
		];
		const index = (step: number, table: string, name: string, columns: readonly string[], unique = false) => ({
			step,
			name,
			run: sql`CREATE ${unique ? sql`UNIQUE ` : sql``}INDEX ${sql(name)} ON ${sql(table)} (${sql.join(",", false)(columns.map((column) => sql`${sql(column)}`))})`.pipe(
				Effect.asVoid,
			),
			postcondition: indexShape(sql, table, name, columns, unique),
		});
		const indexes = [
			...tables.flatMap((table) =>
				table.unique.map((constraint) => index(table.step, table.name, constraint.name, constraint.columns, true)),
			),
			index(5, "source_batches", "source_single_publication", ["publishing_guard"], true),
			index(5, "versions", "source_versions_path", ["path_hash", "id"]),
			index(7, "tokens", "tokens_family", ["family"]),
			index(13, "db_restore_requests", "db_restore_idempotency", ["session_id", "idempotency_key"], true),
			index(13, "db_restore_requests", "db_restore_active", ["active_guard"], true),
		];
		const names = [
			"generations",
			"settings",
			"edit_lock",
			"authentication",
			"source_history",
			"events",
			"enrollment",
			"refresh",
			"cutover",
			"session_activity",
			"mint_receipts",
			"backup_metadata",
			"recovery_journals",
			"event_filters",
			"combined_restore",
			"reset_pin",
			"store_identity",
			"backup_engine",
			"sqlite_copy_ownership",
		] as const;
		yield* remoteMigrate(
			sql,
			"boot_migrations",
			names.map((name, offset) => ({
				id: offset + 1,
				name,
				operations: [
					...tables
						.filter((table) => table.step === offset + 1)
						.map((table) => ({ ...table, run: table.run.pipe(Effect.asVoid) })),
					...indexes.filter((item) => item.step === offset + 1),
					...(offset === 5
						? [
								{
									name: "initial_sequence",
									run: sql`INSERT INTO seq (singleton,${sql("next")},published_through) VALUES (1,1,0)`.pipe(
										Effect.asVoid,
									),
									postcondition: sql`SELECT singleton FROM seq WHERE singleton=1`.pipe(
										Effect.map((rows) => rows.length === 1),
									),
								},
							]
						: []),
				],
			})),
		);
		// These are the final remote table definitions, not historical migration
		// operations. Recheck on reopen so an applied ledger cannot hide drift.
		for (const table of tables) {
			if (!(yield* table.postcondition))
				return yield* new RemoteMigrationError({ code: "migration_postcondition_failed", ledger: "boot_migrations" });
		}
	});
