import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { safeStoreId } from "./store-identity-diagnostics.ts";

export const BackupCursor = Schema.Struct({ taken_at: Schema.Int, id: Schema.String });
const Summary = Schema.Struct({
	id: Schema.String,
	engine: Schema.Literals(["sqlite", "pg", "mysql"]),
	reason: Schema.String,
	bytes: Schema.Int,
	taken_at: Schema.Int,
	published_through: Schema.NullOr(Schema.Int),
	generation: Schema.NullOr(Schema.Int),
	legacy_store_id: Schema.NullOr(Schema.String),
});

/** Catalog metadata only: listing does not open backup files or certify that a restore would succeed. */
export const makeBackupInventory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return (page: { readonly limit: number; readonly before: typeof BackupCursor.Type | null }) =>
		Effect.gen(function* () {
			const rows = yield* sql`SELECT id,engine,reason,bytes,taken_at,published_through,generation,legacy_store_id FROM backups
   WHERE (${page.before?.taken_at ?? null} IS NULL OR taken_at < ${page.before?.taken_at ?? null}
    OR taken_at = ${page.before?.taken_at ?? null} AND id < ${page.before?.id ?? null})
   ORDER BY taken_at DESC,id DESC LIMIT ${page.limit + 1}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Summary))),
			);
			const items = rows.slice(0, page.limit).map(({ legacy_store_id, ...record }) => ({
				...record,
				// This association authorizes legacy adoption; it is not a freshly inspected artifact identity.
				provenance: {
					kind: legacy_store_id === null ? "not_recorded" : "legacy_adoption",
					store_id: safeStoreId(legacy_store_id),
				},
			}));
			const last = items.at(-1);
			const next =
				rows.length > page.limit && last
					? Buffer.from(
							yield* Schema.encodeEffect(Schema.fromJsonString(BackupCursor))({ taken_at: last.taken_at, id: last.id }),
						).toString("base64url")
					: null;
			const expected = yield* sql`SELECT value FROM settings WHERE key='app_store_id'`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
			);
			return { items, next, expected_store_id: safeStoreId(expected[0]?.value) };
		});
});
export type BackupInventory = Effect.Success<typeof makeBackupInventory>;
