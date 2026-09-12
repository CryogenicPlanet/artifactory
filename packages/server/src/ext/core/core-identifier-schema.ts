import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { KernelError } from "../../kernel/boot-channel.ts";

/** Identifier equality is part of the core contract. Do not constrain extension
 * columns or the deliberately accent-insensitive message search columns. */
export const assertCoreIdentifierCollations = (sql: SqlClient) =>
	Effect.gen(function* () {
		if (!on(sql, { sqlite: () => false, pg: () => false, mysql: () => true })) return;
		for (const [table, columns] of [
			["topics", ["path", "parent"]],
			["messages", ["id", "topic", "agent", "instance"]],
			["reads", ["instance", "topic"]],
			["kv", ["ns", "key"]],
			["idempotency", ["instance", "key", "key_hash"]],
			["topic_page_continuations", ["from_path", "to_path"]],
		] as const) {
			const rows =
				yield* sql`SELECT COLUMN_NAME AS name,COLLATION_NAME AS collation FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND ${sql.in("COLUMN_NAME", columns)}`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(Schema.Struct({ name: Schema.String, collation: Schema.NullOr(Schema.String) })),
						),
					),
				);
			if (rows.length !== columns.length || rows.some((row) => row.collation !== "utf8mb4_0900_bin"))
				return yield* new KernelError({ code: "app_schema_unsupported" });
		}
	});
