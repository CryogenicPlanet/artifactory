import { bootTable, column, hashColumn } from "./boot-table-definition.ts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

const noConstraints = [
	{ foreignKeys: [], checks: [] },
	{ foreignKeys: [], checks: [] },
] as const;
const passkeyColumns = [
	column("row_id", "integer", false, { identity: true }),
	column("id", "text", false),
	column("public_key", "text", false),
	column("counter", "integer", false),
	column("transports", "text", false),
	column("label", "text", false),
	column("created_at", "integer", false),
	hashColumn("id"),
];
const passkeys = (sql: SqlClient, engine: "pg" | "mysql", step: number, columns: typeof passkeyColumns) =>
	bootTable(
		sql,
		engine,
		step,
		"passkeys",
		columns,
		["row_id"],
		['PRIMARY KEY ("row_id")', "PRIMARY KEY (`row_id`)"],
		noConstraints,
		[{ name: "passkeys_id_hash_unique", columns: ["id_hash"] }],
	);

const sessionColumns = [
	column("id", 128, false),
	column("hash", 64, false),
	column("created_at", "integer", false),
	column("expires_at", "integer", false),
	column("last_seen_at", "integer", true),
];
const sessions = (sql: SqlClient, engine: "pg" | "mysql", step: number, columns: typeof sessionColumns) =>
	bootTable(
		sql,
		engine,
		step,
		"sessions",
		columns,
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		noConstraints,
		[{ name: "sessions_hash_unique", columns: ["hash"] }],
	);

/** One nullable text column appended to a step-4 table, owned once it exists with the table's final shape. */
const appendColumn = (
	sql: SqlClient,
	engine: "pg" | "mysql",
	final: ReturnType<typeof bootTable>,
	table: "passkeys" | "sessions",
	name: "rp_id" | "origin",
	length: number,
) => {
	const present =
		engine === "pg"
			? sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name=${name}`
			: sql`SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${table} AND COLUMN_NAME=${name}`;
	return {
		name: `${table}_${name}`,
		run: sql
			.unsafe(
				engine === "pg"
					? `ALTER TABLE "${table}" ADD COLUMN "${name}" text`
					: `ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` varchar(${length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
			)
			.pipe(Effect.asVoid),
		postcondition: present.pipe(Effect.flatMap((rows) => (rows.length ? final.postcondition : Effect.succeed(false)))),
	};
};

/** Step 20 appends passkeys.rp_id and sessions.origin. Reopen rechecks these final shapes, not step 4's. */
export const appendedAuthColumns = (sql: SqlClient, engine: "pg" | "mysql") => {
	const finalPasskeys = passkeys(sql, engine, 20, [...passkeyColumns, column("rp_id", 255, true)]);
	const finalSessions = sessions(sql, engine, 20, [...sessionColumns, column("origin", 512, true)]);
	return {
		finals: [finalPasskeys, finalSessions],
		operations: [
			appendColumn(sql, engine, finalPasskeys, "passkeys", "rp_id", 255),
			appendColumn(sql, engine, finalSessions, "sessions", "origin", 512),
		],
	};
};

export const authTables = (sql: SqlClient, engine: "pg" | "mysql") => [
	passkeys(sql, engine, 4, passkeyColumns),
	bootTable(
		sql,
		engine,
		4,
		"auth_challenges",
		[
			column("id", 128, false),
			column("challenge", "text", false),
			column("ceremony", 128, false),
			column("setup_generation", 128, true),
			column("expires_at", "integer", false),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[],
	),
	sessions(sql, engine, 4, sessionColumns),
	bootTable(
		sql,
		engine,
		7,
		"enrollments",
		[
			column("id", 128, false),
			column("device_secret_hash", 64, false),
			column("user_code", 128, false),
			column("agent_name", 64, false),
			column("kind", "text", false),
			column("host", "text", false),
			column("status", 16, false, {
				suffix: [
					" CHECK (\"status\" IN ('pending','approved','denied','collected'))",
					" CHECK (`status` IN ('pending','approved','denied','collected'))",
				],
			}),
			column("family", 128, false),
			column("created_at", "integer", false),
			column("expires_at", "integer", false),
			column("collected_at", "integer", true),
			column("scopes", "text", true),
			column("access_seconds", "integer", true),
			column("refresh_seconds", "integer", true),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{
				foreignKeys: [],
				checks: ["(status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'collected'::text]))"],
			},
			{
				foreignKeys: [],
				checks: [
					"(`status` in (_utf8mb4\\'pending\\',_utf8mb4\\'approved\\',_utf8mb4\\'denied\\',_utf8mb4\\'collected\\'))",
				],
			},
		],
		[{ name: "enrollments_family_unique", columns: ["family"] }],
	),
	bootTable(
		sql,
		engine,
		7,
		"tokens",
		[
			column("id", 128, false),
			column("pair_id", 128, false),
			column("family", 128, false),
			column("agent", 64, false),
			column("kind", 16, false, {
				suffix: [" CHECK (\"kind\" IN ('access','refresh'))", " CHECK (`kind` IN ('access','refresh'))"],
			}),
			column("hash", 64, false),
			column("label", "text", false),
			column("scopes", "text", false),
			column("expires_at", "integer", false),
			column("created_at", "integer", false),
			column("last_used_at", "integer", true),
			column("revoked_at", "integer", true),
			column("rotated_to", 128, true),
			column("rotated_at", "integer", true),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{ foreignKeys: [], checks: ["(kind = ANY (ARRAY['access'::text, 'refresh'::text]))"] },
			{ foreignKeys: [], checks: ["(`kind` in (_utf8mb4\\'access\\',_utf8mb4\\'refresh\\'))"] },
		],
		[{ name: "tokens_hash_unique", columns: ["hash"] }],
	),
	bootTable(
		sql,
		engine,
		8,
		"refresh_receipts",
		[
			column("predecessor", 128, false),
			column("family", 128, false),
			column("successor_access_id", 128, false),
			column("successor_refresh_id", 128, false),
			column("expires_at", "integer", false),
			column("salt", "text", false),
			column("nonce", "text", false),
			column("ciphertext", "text", false),
			column("tag", "text", false),
		],
		["predecessor"],
		['PRIMARY KEY ("predecessor")', "PRIMARY KEY (`predecessor`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		8,
		"refresh_idempotency",
		[
			column("family", 128, false),
			column("key_hash", 64, false),
			column("predecessor", 128, false),
			column("expires_at", "integer", false),
		],
		["family", "key_hash"],
		['PRIMARY KEY ("family","key_hash")', "PRIMARY KEY (`family`,`key_hash`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[],
	),
	bootTable(
		sql,
		engine,
		11,
		"mint_receipts",
		[
			column("session_id", 128, false),
			column("key_hash", 64, false),
			column("request_hash", 64, false),
			column("proof_hash", 64, false),
			column("family", 128, false),
			column("successor_access_id", 128, false),
			column("successor_refresh_id", 128, false),
			column("expires_at", "integer", false),
			column("salt", "text", false),
			column("nonce", "text", false),
			column("ciphertext", "text", false),
			column("tag", "text", false),
		],
		["session_id", "key_hash"],
		['PRIMARY KEY ("session_id","key_hash")', "PRIMARY KEY (`session_id`,`key_hash`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[{ name: "mint_receipts_session_id_proof_hash_unique", columns: ["session_id", "proof_hash"] }],
	),
	bootTable(
		sql,
		engine,
		20,
		"auth_origins",
		[column("origin", 512, false), column("rp_id", 255, false), column("created_at", "integer", false)],
		["origin"],
		['PRIMARY KEY ("origin")', "PRIMARY KEY (`origin`)"],
		noConstraints,
		[],
	),
	bootTable(
		sql,
		engine,
		20,
		"passkey_codes",
		[
			column("id", 128, false),
			column("selector", 12, false),
			column("hash", 64, false),
			column("origin", 512, true),
			column("failures", "integer", false),
			column("locked_until", "integer", false),
			column("proven", "integer", false),
			column("proof_id", 128, true),
			column("proof_nonce", 128, true),
			column("proof_expires_at", "integer", true),
			column("expires_at", "integer", false),
			column("created_at", "integer", false),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		noConstraints,
		[],
	),
];
