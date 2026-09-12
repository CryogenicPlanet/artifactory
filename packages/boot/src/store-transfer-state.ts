import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { EventError } from "./events.ts";

/** Compatibility markers are deliberately separate from the offline coordinator's journal.
 * Unknown states fail closed; neither descriptions nor credentials enter the error. */
export const assertTransferState = (rows: ReadonlyArray<{ readonly key: string; readonly value: string }>) =>
	Effect.gen(function* () {
		if (rows.some((row) => row.key === "transferred_to")) return yield* new EventError({ code: "store_transferred" });
		if (rows.some((row) => row.key === "transfer_state" && row.value !== "complete"))
			return yield* new EventError({ code: "store_transfer_incomplete" });
	});

/** Run before schema initialization or recovery. An absent settings table is a legacy/fresh store. */
export const assertBootTransferState = (sql: SqlClient) =>
	Effect.gen(function* () {
		const tables = yield* on(sql, {
			sqlite: () => sql`SELECT name FROM sqlite_master WHERE name='settings'`,
			pg: () => sql`SELECT relname FROM pg_catalog.pg_class WHERE oid=to_regclass('settings')`,
			mysql: () =>
				sql`SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='settings'`,
		});
		if (tables.length === 0) return;
		const rows =
			yield* sql`SELECT ${sql("key")},value FROM settings WHERE ${sql("key")} IN ('transferred_to','transfer_state')`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
				),
			);
		yield* assertTransferState(rows);
	});
