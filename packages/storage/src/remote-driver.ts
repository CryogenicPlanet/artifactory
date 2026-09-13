import { postgresTypes, mysqlTypeCast } from "./remote-values.ts";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { Cause, Effect, type Scope } from "effect";
import type { Reactivity } from "effect/unstable/reactivity/Reactivity";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import { type RemoteConnection, RemoteConnectionRejected } from "./remote-session.ts";

export const open = (options: RemoteConnection, tag: string) => {
	const common = {
		host: options.host,
		port: options.port,
		database: options.database,
		username: options.username,
		password: options.password,
		maxConnections: 1,
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
	return connectionFailure(client, options);
};
export const compiler = (engine: RemoteConnection["engine"]) =>
	engine === "pg" ? PgClient.makeCompiler() : MysqlClient.makeCompiler();

export const connectionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, connection: RemoteConnection) =>
	effect.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
			const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
			const error =
				reason && Cause.isFailReason(reason) && isSqlError(reason.error) ? reason.error.reason.cause : undefined;
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			const errno = typeof error === "object" && error !== null && "errno" in error ? error.errno : undefined;
			return Effect.fail(
				new RemoteConnectionRejected({
					code:
						code === "3D000" || errno === 1049 || errno === 1044
							? "remote_database_unavailable"
							: code === "28P01" || code === "28000" || errno === 1045
								? "remote_role_rejected"
								: "remote_connection_failed",
					database: connection.database,
					role: connection.username,
				}),
			);
		}),
	);
