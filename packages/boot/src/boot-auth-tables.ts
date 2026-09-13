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

/** Step 20 appends rp_id to the step-4 passkeys table. Reopen rechecks this final shape, not step 4's. */
export const passkeyRpId = (sql: SqlClient, engine: "pg" | "mysql") => {
	const final = passkeys(sql, engine, 20, [...passkeyColumns, column("rp_id", 255, true)]);
	const present =
		engine === "pg"
			? sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='passkeys' AND column_name='rp_id'`
			: sql`SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='passkeys' AND COLUMN_NAME='rp_id'`;
	return {
		final,
		operation: {
			name: "passkeys_rp_id",
			run: sql
				.unsafe(
					engine === "pg"
						? 'ALTER TABLE "passkeys" ADD COLUMN "rp_id" text'
						: "ALTER TABLE `passkeys` ADD COLUMN `rp_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
				)
				.pipe(Effect.asVoid),
			postcondition: present.pipe(
				Effect.flatMap((rows) => (rows.length ? final.postcondition : Effect.succeed(false))),
			),
		},
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
	bootTable(
		sql,
		engine,
		4,
		"sessions",
		[
			column("id", 128, false),
			column("hash", 64, false),
			column("created_at", "integer", false),
			column("expires_at", "integer", false),
			column("last_seen_at", "integer", true),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		[
			{ foreignKeys: [], checks: [] },
			{ foreignKeys: [], checks: [] },
		],
		[{ name: "sessions_hash_unique", columns: ["hash"] }],
	),
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
			column("hash", 64, false),
			column("origin", 512, true),
			column("failures", "integer", false),
			column("expires_at", "integer", false),
			column("created_at", "integer", false),
		],
		["id"],
		['PRIMARY KEY ("id")', "PRIMARY KEY (`id`)"],
		noConstraints,
		[],
	),
];
