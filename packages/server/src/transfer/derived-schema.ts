import type { TransferDerivedObject } from "@comms/storage/transfer-inventory";

export type TransferEngine = "sqlite" | "pg" | "mysql";
export type TransferStore = "boot" | "app";

/** Definitions are copied from the trusted core migration, never learned from the source catalog. */
export const coreSearchObjects: readonly TransferDerivedObject[] = [
	{
		name: "messages_fts",
		kind: "table",
		definition:
			"CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, body, previous_body, tokenize='unicode61 remove_diacritics 2')",
	},
	{
		name: "messages_fts_insert",
		kind: "trigger",
		definition:
			"CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,message_id,body,previous_body) VALUES(new.rowid,new.id,new.body,json_extract(new.previous,'$.body')); END",
	},
	{
		name: "messages_fts_update",
		kind: "trigger",
		definition:
			"CREATE TRIGGER messages_fts_update AFTER UPDATE OF body,previous ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; INSERT INTO messages_fts(rowid,message_id,body,previous_body) VALUES(new.rowid,new.id,new.body,json_extract(new.previous,'$.body')); END",
	},
	{
		name: "messages_fts_delete",
		kind: "trigger",
		definition:
			"CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; END",
	},
];
export const coreJsonColumns = [
	{ table: "messages", column: "tags" },
	{ table: "messages", column: "meta" },
	{ table: "topics", column: "meta" },
] as const;

export const syntheticKey = (store: TransferStore, table: string): readonly string[] | undefined => {
	if (store === "app") return table === "idempotency" ? ["instance", "key"] : undefined;
	switch (table) {
		case "passkeys":
		case "event_batches":
			return ["id"];
		case "public_paths":
			return ["path"];
		case "staging":
			return ["lock_id", "path"];
		case "source_changes":
			return ["batch", "path"];
		default:
			return undefined;
	}
};
const hashColumn = (store: TransferStore, table: string): string | undefined => {
	if (store === "app") return table === "idempotency" ? "key" : undefined;
	switch (table) {
		case "passkeys":
		case "event_batches":
			return "id";
		case "public_paths":
		case "staging":
		case "source_changes":
		case "versions":
			return "path";
		default:
			return undefined;
	}
};

/** Every accepted remote generated expression has a named, trusted migration counterpart. */
export const derivedExpression = (
	store: TransferStore,
	engine: TransferEngine,
	table: string,
	column: string,
): string | undefined => {
	if (engine === "sqlite") return undefined;
	// Stock subscriptions migration uses binary SHA-256 uniqueness projections only on MySQL.
	if (store === "app" && engine === "mysql" && table === "webhook_subscriptions") {
		if (column === "instance_hash") return "unhex(sha2(`instance`,256))";
		if (column === "idempotency_hash") return "unhex(sha2(`idempotency_key`,256))";
	}
	const hash = hashColumn(store, table);
	if (hash && column === `${hash}_hash`)
		return engine === "mysql"
			? `sha2(\`${hash}\`,256)`
			: `encode(sha256(decode(replace(${hash}, chr(92), (chr(92) || chr(92))), 'escape'::text)), 'hex'::text)`;
	if (store === "boot" && table === "events" && ["type", "actor", "instance", "level"].includes(column))
		return engine === "pg"
			? `((event)::jsonb ->> '${column}'::text)`
			: `(case when (json_type(json_extract(\`event\`,_utf8mb4\\'$.${column}\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(\`event\`,_utf8mb4\\'$.${column}\\')) end)`;
	if (store === "boot" && table === "source_batches" && column === "publishing_guard")
		return engine === "pg"
			? "CASE WHEN (state = 'publishing'::text) THEN 1 ELSE NULL::integer END"
			: "(case when (`state` = _utf8mb4\\'publishing\\') then 1 else NULL end)";
	if (store === "boot" && table === "db_restore_requests" && column === "active_guard")
		return engine === "pg"
			? "CASE WHEN (phase = ANY (ARRAY['authorized'::text, 'restoring'::text, 'working'::text, 'rollback'::text])) THEN 1 ELSE NULL::integer END"
			: "(case when (`phase` in (_utf8mb4\\'authorized\\',_utf8mb4\\'restoring\\',_utf8mb4\\'working\\',_utf8mb4\\'rollback\\')) then 1 else NULL end)";
	if (store === "app" && table === "messages") {
		if (engine === "pg" && column === "body_tsv") return "to_tsvector('simple'::regconfig, COALESCE(body, ''::text))";
		if (engine === "pg" && column === "previous_body_tsv")
			return "to_tsvector('simple'::regconfig, COALESCE(((previous)::jsonb ->> 'body'::text), ''::text))";
		if (engine === "mysql" && column === "previous_body")
			return "(case when (json_type(json_extract(`previous`,_utf8mb4\\'$.body\\')) = _utf8mb4\\'NULL\\') then NULL else json_unquote(json_extract(`previous`,_utf8mb4\\'$.body\\')) end)";
	}
	return undefined;
};

/** SQLite stores generated expressions only inside CREATE TABLE text. Boot's events schema is immutable. */
export const sqliteEventsDefinition =
	"CREATE TABLE events (seq INTEGER PRIMARY KEY, transaction_id TEXT, event TEXT NOT NULL, topic TEXT, type TEXT GENERATED ALWAYS AS (json_extract(event,'$.type')) VIRTUAL, actor TEXT GENERATED ALWAYS AS (json_extract(event,'$.actor')) VIRTUAL, instance TEXT GENERATED ALWAYS AS (json_extract(event,'$.instance')) VIRTUAL, level TEXT GENERATED ALWAYS AS (json_extract(event,'$.level')) VIRTUAL)";

/** Immutable boot migration 13. An exact catalog match is required before ignoring its expression. */
export const bootDerivedObjects: readonly TransferDerivedObject[] = [
	{
		name: "db_restore_active",
		kind: "index",
		definition:
			"CREATE UNIQUE INDEX db_restore_active ON db_restore_requests ((1))\n\t\tWHERE phase IN ('authorized','restoring','working','rollback')",
	},
];
