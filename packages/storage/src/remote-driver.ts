import { postgresTypes, mysqlTypeCast } from "./remote-values.ts";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { Cause, Effect, Schema, type Scope } from "effect";
import type { Reactivity } from "effect/unstable/reactivity/Reactivity";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import {
	type RemoteConnection,
	type RemoteSession,
	failure,
	sanitized,
	RemoteAuthenticationRejected,
} from "./remote-session.ts";

export const open = (options: RemoteConnection, tag: string) => {
	const common = {
		host: options.host,
		port: options.port,
		database: options.database,
		username: options.username,
		password: options.password,
		maxConnections: 4,
	};
	const client: Effect.Effect<SqlClient, SqlError, Scope.Scope | Reactivity> =
		options.engine === "pg"
			? PgClient.make({ ...common, ssl: options.tls, applicationName: tag, multiplex: false, types: postgresTypes() })
			: MysqlClient.make({
					...common,
					poolConfig: {
						// mysql2 verifies the chain by default but requires this separate hostname check.
						...(options.tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
						connectAttributes: { comms_attempt: tag },
						bigNumberStrings: true,
						typeCast: mysqlTypeCast,
						jsonStrings: true,
					},
				});
	return sanitized(client, "remote_connection_failed");
};
/** Classify only at the first physical login boundary, before any successful connection.
 * AuthenticationError alone also covers unsupported auth and failed server SCRAM proof. */
export const initialInspectorFailure = (engine: RemoteConnection["engine"], error: unknown) => {
	if (isSqlError(error) && error.reason._tag === "AuthenticationError" && error.reason.operation === "connect") {
		const cause = error.reason.cause;
		if (typeof cause === "object" && cause !== null) {
			if (engine === "pg" && "code" in cause && cause.code === "28P01")
				return new RemoteAuthenticationRejected({ engine, code: "28P01" });
			if (
				engine === "mysql" &&
				"errno" in cause &&
				cause.errno === 1045 &&
				"sqlState" in cause &&
				cause.sqlState === "28000"
			)
				return new RemoteAuthenticationRejected({ engine, code: "1045" });
		}
	}
	return failure("remote_connection_failed");
};

/** Inspector-only: PG uses one physical session without pool/reconnection. MySQL's first
 * make performs exactly its initial SELECT 1; later reserve/identify failures are never auth proof.
 * The owner must close the failed acquisition scope before publishing a rejection receipt. */
export const openInspector = (options: RemoteConnection, tag: string) => {
	const common = {
		host: options.host,
		port: options.port,
		database: options.database,
		username: options.username,
		password: options.password,
	};
	const client: Effect.Effect<SqlClient, SqlError, Scope.Scope | Reactivity> =
		options.engine === "pg"
			? PgClient.makeClient({
					...common,
					ssl: options.tls,
					applicationName: tag,
					multiplex: false,
					types: postgresTypes(),
				})
			: MysqlClient.make({
					...common,
					maxConnections: 1,
					poolConfig: {
						...(options.tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
						connectAttributes: { comms_attempt: tag },
						bigNumberStrings: true,
						typeCast: mysqlTypeCast,
						jsonStrings: true,
					},
				});
	return client.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
			const only = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
			return Effect.fail(
				only && Cause.isFailReason(only)
					? initialInspectorFailure(options.engine, only.error)
					: failure("remote_connection_failed"),
			);
		}),
	);
};

export const compiler = (engine: RemoteConnection["engine"]) =>
	engine === "pg" ? PgClient.makeCompiler() : MysqlClient.makeCompiler();

const identityFields = [Schema.String, Schema.String, Schema.String, Schema.String, Schema.String] as const;
const Metadata = Schema.Array(
	Schema.Union([Schema.Tuple(identityFields), Schema.Tuple([...identityFields, Schema.String])]),
);
/** Bootstrap metadata only; application SQL cannot run until its lease is registered. */
export const identify = (connection: Connection, options: RemoteConnection, tag: string) =>
	sanitized(
		Effect.gen(function* () {
			const query =
				options.engine === "pg"
					? "SELECT pg_catalog.pg_postmaster_start_time()::text, pg_catalog.current_database()::text, current_user::text, pg_catalog.pg_backend_pid()::text, pg_catalog.current_setting('application_name') WHERE pg_catalog.current_setting('max_prepared_transactions')='0'"
					: "SELECT @@server_uuid, DATABASE(), CURRENT_USER(), CAST(CONNECTION_ID() AS CHAR), (SELECT ATTR_VALUE FROM performance_schema.session_account_connect_attrs WHERE PROCESSLIST_ID=CONNECTION_ID() AND ATTR_NAME='comms_attempt'), @@SESSION.transaction_isolation";
			const rows = yield* connection
				.executeValues(query, [])
				.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Metadata)), Effect.interruptible, Effect.timeout("5 seconds"));
			const row = rows[0];
			if (options.engine === "mysql" && (row?.length !== 6 || row[5] !== "REPEATABLE-READ"))
				return yield* failure("remote_isolation_unsupported");
			if (
				rows.length !== 1 ||
				!row ||
				!row[0] ||
				row[1] !== options.database ||
				row[4] !== tag ||
				!/^\d+$/.test(row[3])
			)
				return yield* failure("remote_inspection_failed");
			// MySQL CURRENT_USER includes its matched host account. Keep that exact identity.
			return {
				engine: options.engine,
				server: row[0],
				database: row[1],
				username: row[2],
				connectionId: row[3],
				tag,
			} satisfies RemoteSession;
		}),
		"remote_inspection_failed",
	);

const Connections = Schema.Array(Schema.Tuple([Schema.String]));
export const sessions = (connection: Connection, engine: RemoteConnection["engine"], tag: string) =>
	sanitized(
		connection
			.executeValues(
				engine === "pg"
					? "SELECT pid::text FROM pg_catalog.pg_stat_activity WHERE usename=current_user AND application_name=$1"
					: "SELECT CAST(PROCESSLIST_ID AS CHAR) FROM performance_schema.session_account_connect_attrs WHERE ATTR_NAME='comms_attempt' AND ATTR_VALUE=?",
				[tag],
			)
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Connections)), Effect.interruptible, Effect.timeout("5 seconds")),
		"remote_inspection_failed",
	);

/** Registered IDs remain relevant even if application SQL changes a mutable tag. */
export const connectionIds = (connection: Connection, engine: RemoteConnection["engine"]) =>
	sanitized(
		connection
			.executeValues(
				engine === "pg"
					? "SELECT pid::text FROM pg_catalog.pg_stat_activity"
					: "SELECT CAST(ID AS CHAR) FROM information_schema.PROCESSLIST",
				[],
			)
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Connections)), Effect.interruptible, Effect.timeout("5 seconds")),
		"remote_inspection_failed",
	);

/** All sessions for the app login, including raw connections without a comms tag. */
export const accountSessions = (connection: Connection, options: RemoteConnection) =>
	sanitized(
		connection
			.executeValues(
				options.engine === "pg"
					? "SELECT pid::text FROM pg_catalog.pg_stat_activity WHERE usename=current_user"
					: "SELECT CAST(ID AS CHAR) FROM information_schema.PROCESSLIST WHERE USER=?",
				options.engine === "pg" ? [] : [options.username],
			)
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Connections)), Effect.interruptible, Effect.timeout("5 seconds")),
		"remote_inspection_failed",
	);

/** MySQL 8 requires XA_RECOVER_ADMIN; refusal/missing visibility must fail closure, never act as an empty result. */
export const assertNoPreparedXa = (connection: Connection) =>
	sanitized(
		Effect.gen(function* () {
			const rows = yield* connection
				.executeValuesUnprepared("XA RECOVER", [])
				.pipe(Effect.interruptible, Effect.timeout("5 seconds"));
			if (rows.length !== 0) return yield* failure("remote_sessions_open");
		}),
		"remote_inspection_failed",
	);
