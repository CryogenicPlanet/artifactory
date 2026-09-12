import type { RemoteStore } from "@comms/storage/store";
import { Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RemoteDatabaseError, type MysqlProvisionStage, type RemoteDatabaseRecord } from "./remote-database-journal.ts";

const invalid = () => new RemoteDatabaseError({ code: "remote_database_invalid" });
const identifier = (value: string) => `\`${value.replaceAll("`", "``")}\``;
// Database names in GRANT are patterns even when quoted as identifiers.
const grantDatabase = (value: string) => identifier(value.replace(/[_%]/g, "\\$&"));
const account = (name: string) => `${identifier(name)}@'%'`;
const permissions = "SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES";
const loaderPermissions = `${permissions}, LOCK TABLES`;

/** Receipts live in the boot database and commit independently after exclusive CREATE succeeds. */
export interface MysqlDatabaseReceipts<E, R> {
	readonly created: (record: RemoteDatabaseRecord, resource: "database") => Effect.Effect<void, E, R>;
	readonly owns: (record: RemoteDatabaseRecord, resource: "database") => Effect.Effect<boolean, E, R>;
}

/** Guarded boot client only. The caller proves account/process closure before marking a resource closed. */
export const mysqlDatabaseProvision = <E, R>(receipts: MysqlDatabaseReceipts<E, R>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const execute = (stage: typeof MysqlProvisionStage.Type, statement: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					// MySQL DDL commits implicitly; never escape an enclosing boot transaction.
					if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
						return yield* new RemoteDatabaseError({ code: "mysql_ddl_in_transaction", stage });
					const connection = yield* sql.reserve;
					// Password-bearing CREATE USER must not enter Effect SQL statement traces.
					yield* connection.executeUnprepared(statement, [], undefined);
				}),
			).pipe(
				Effect.mapError((error) =>
					Schema.is(RemoteDatabaseError)(error)
						? error
						: new RemoteDatabaseError({ code: "remote_database_provision_failed", stage }),
				),
			);
		const validate = (record: RemoteDatabaseRecord) => {
			const compact = record.id.replaceAll("-", "");
			return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id) &&
				record.endpoint.startsWith("mysql://") &&
				record.principal === `comms_t_${compact.slice(0, 24)}` &&
				(record.kind === "dump" ||
					record.database === `comms_${record.kind === "restore" ? "app" : "rehearsal"}_${compact}`)
				? Effect.void
				: Effect.fail(invalid());
		};
		const selected = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				yield* validate(record);
				const rows = yield* sql`SELECT DATABASE() AS name`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) }))),
					),
				);
				if (rows.length !== 1 || rows[0]?.name !== record.database) return yield* invalid();
			});
		const provePrincipal = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				yield* validate(record);
				const rows =
					yield* sql`SELECT HOST AS host, JSON_UNQUOTE(JSON_EXTRACT(ATTRIBUTE,'$.comms_resource')) AS stamp FROM information_schema.USER_ATTRIBUTES WHERE USER=${record.principal}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(Schema.Struct({ host: Schema.String, stamp: Schema.NullOr(Schema.String) })),
							),
						),
					);
				if (rows.length > 1 || (rows.length === 1 && (rows[0]?.host !== "%" || rows[0]?.stamp !== record.id)))
					return yield* invalid();
				return rows.length === 1;
			});
		const createPrincipal = (record: RemoteDatabaseRecord, credential: RemoteStore) =>
			Effect.gen(function* () {
				yield* validate(record);
				const url = yield* Effect.try({ try: () => new URL(Redacted.value(credential.url)), catch: invalid });
				const password = yield* Effect.try({ try: () => decodeURIComponent(url.password), catch: invalid });
				if (
					record.phase !== "allocated" ||
					credential._tag !== "mysql" ||
					credential.database !== record.database ||
					url.username !== record.principal ||
					!/^[0-9a-f]{64}$/.test(password) ||
					`mysql://${url.hostname}:${url.port || "3306"}` !== record.endpoint
				)
					return yield* invalid();
				const existing = yield* sql`SELECT HOST FROM information_schema.USER_ATTRIBUTES WHERE USER=${record.principal}`;
				if (existing.length !== 0) return yield* invalid();
				// No IF NOT EXISTS: a colliding account is never adopted. ATTRIBUTE commits with creation.
				// MySQL's session_account_connect_attrs uses pfs_readonly_world_acl and filters rows by account.
				// It needs no delegated SELECT grant: mysql-server/mysql-8.4.11 table_session_account_connect_attrs.cc.
				yield* execute(
					"create_principal",
					`CREATE USER ${account(record.principal)} IDENTIFIED BY '${password}' ATTRIBUTE '{"comms_resource":"${record.id}"}'`,
				);
			});
		const createDatabase = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				yield* validate(record);
				if (record.kind === "dump" || record.phase !== "allocated" || !(yield* provePrincipal(record)))
					return yield* invalid();
				yield* execute(
					"create_database",
					`CREATE DATABASE ${identifier(record.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs`,
				);
				// An uncertain receipt leaves an orphan, never permission to delete an existing database.
				yield* receipts.created(record, "database");
				// Existing native dumps contain LOCK TABLES; only the disposable loader needs this privilege.
				yield* execute(
					"grant_loader",
					`GRANT ${loaderPermissions} ON ${grantDatabase(record.database)}.* TO ${account(record.principal)}`,
				);
			});
		const grantSchema = selected;
		const protectKernel = (record: RemoteDatabaseRecord, _appRole = record.principal) =>
			Effect.gen(function* () {
				yield* selected(record);
				// MySQL has no ownership-based DDL protection. The recovery preflight validates these tables.
				const rows =
					yield* sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=${record.database} AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME IN ('kernel_writer','mutation_batches','outbox','store_identity')`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String })))),
					);
				if (new Set(rows.map((row) => row.name)).size !== 4) return yield* invalid();
			});
		const revoke = (record: RemoteDatabaseRecord, stage: "revoke_loader" | "revoke_dump", allowed: string) =>
			Effect.gen(function* () {
				const rows =
					yield* sql`SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=${`'${record.principal}'@'%'`} AND TABLE_SCHEMA=${record.database.replace(/[_%]/g, "\\$&")}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ privilege: Schema.String })))),
					);
				// A previous atomic REVOKE may have committed before the journal phase advanced.
				if (rows.length === 0) return;
				const permitted = allowed.split(", ");
				if (rows.some((row) => !permitted.includes(row.privilege))) return yield* invalid();
				yield* execute(
					stage,
					`REVOKE ${rows.map((row) => row.privilege).join(", ")} ON ${grantDatabase(record.database)}.* FROM ${account(record.principal)}`,
				);
			});
		const handoff = (record: RemoteDatabaseRecord, appRole: string) =>
			Effect.gen(function* () {
				if (record.kind !== "restore" || record.phase !== "ready" || !appRole || /[\\\x00-\x1f\x7f]/.test(appRole))
					return yield* invalid();
				yield* selected(record);
				if (!(yield* provePrincipal(record)) || !(yield* receipts.owns(record, "database"))) return yield* invalid();
				yield* protectKernel(record);
				yield* execute(
					"handoff_app",
					`GRANT ${permissions} ON ${grantDatabase(record.database)}.* TO ${account(appRole)}`,
				);
				yield* revoke(record, "revoke_loader", loaderPermissions);
			});
		const catalogVisible = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				const accounts =
					yield* sql`SELECT CURRENT_USER() AS account, CAST(@@GLOBAL.partial_revokes AS CHAR) AS partial_revokes`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(Schema.Struct({ account: Schema.String, partial_revokes: Schema.String })),
							),
						),
					);
				const current = accounts[0];
				if (accounts.length !== 1 || !current || current.partial_revokes !== "0") return yield* invalid();
				const split = current.account.lastIndexOf("@");
				if (split < 1) return yield* invalid();
				const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
				const grantee = `${quote(current.account.slice(0, split))}@${quote(current.account.slice(split + 1))}`;
				// Require direct schema grants, as supplied by the operator script. Role/global-only grants
				// are deliberately insufficient proof here; partial revokes could hide narrower access.
				const rows =
					yield* sql`SELECT TABLE_SCHEMA AS pattern, PRIVILEGE_TYPE AS privilege FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=${grantee} AND ${record.database} LIKE TABLE_SCHEMA ESCAPE ${"\\"}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(Schema.Struct({ pattern: Schema.String, privilege: Schema.String })),
							),
						),
					);
				// Multiple wildcard matches do not accumulate permissions in MySQL. Refuse ambiguity.
				if (new Set(rows.map((row) => row.pattern)).size !== 1) return yield* invalid();
				const granted = new Set(rows.map((row) => row.privilege));
				if (["SELECT", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE"].some((privilege) => !granted.has(privilege)))
					return yield* invalid();
			});
		const assertSupported = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				yield* selected(record);
				yield* catalogVisible(record);
				// Never interpret privilege-filtered catalog emptiness as proof of absence.
				const rows =
					yield* sql`SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA=${record.database} UNION ALL SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${record.database} UNION ALL SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=${record.database} UNION ALL SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA=${record.database}`;
				if (rows.length !== 0) return yield* new RemoteDatabaseError({ code: "mysql_clone_objects_unsupported" });
			});
		const grantDump = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				if (record.kind !== "dump" || record.phase !== "allocated") return yield* invalid();
				yield* assertSupported(record);
				if (!(yield* provePrincipal(record))) return yield* invalid();
				yield* execute(
					"grant_dump",
					`GRANT SELECT ON ${grantDatabase(record.database)}.* TO ${account(record.principal)}`,
				);
			});
		const revokeDump = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				if (record.kind !== "dump" || record.phase !== "closed") return yield* invalid();
				yield* selected(record);
				if (!(yield* provePrincipal(record))) return;
				yield* revoke(record, "revoke_dump", "SELECT");
			});
		const dropPrincipal = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				if (record.phase !== "closed") return yield* invalid();
				if (yield* provePrincipal(record)) yield* execute("drop_principal", `DROP USER ${account(record.principal)}`);
			});
		const dropRehearsal = (record: RemoteDatabaseRecord) =>
			Effect.gen(function* () {
				yield* validate(record);
				if (record.kind !== "rehearsal" || record.phase !== "closed" || !(yield* receipts.owns(record, "database")))
					return yield* invalid();
				// Receipt ownership assumes the operator reserves generated names; external replacements are never adopted.
				yield* provePrincipal(record);
				const rows =
					yield* sql`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${record.database}`;
				if (rows.length > 1) return yield* invalid();
				if (rows.length === 1) yield* execute("drop_database", `DROP DATABASE ${identifier(record.database)}`);
				yield* dropPrincipal(record);
			});
		return {
			createPrincipal,
			createDatabase,
			grantSchema,
			protectKernel,
			handoff,
			assertSupported,
			grantDump,
			revokeDump,
			dropPrincipal,
			dropRehearsal,
		};
	});
