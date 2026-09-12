import { Cause, Effect, Encoding, Redacted, Result } from "effect";
import {
	SqlError,
	UnknownError,
	UniqueViolation,
	DeadlockError,
	SerializationError,
	isSqlError,
} from "effect/unstable/sql/SqlError";

/** Explicit fields prevent driver URL parameters from overriding identity or handshake tags. */
export interface RemoteConnection {
	readonly engine: "pg" | "mysql";
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly username: string;
	readonly password: Redacted.Redacted<string>;
	readonly tls: boolean;
}
export interface RemoteSession {
	readonly engine: RemoteConnection["engine"];
	readonly server: string;
	readonly database: string;
	readonly username: string;
	readonly connectionId: string;
	readonly tag: string;
}
export interface RemoteAttempt {
	readonly connection: RemoteConnection;
	/** Existing 256-bit boot attempt, encoded as 64 lowercase hexadecimal characters. */
	readonly attempt: string;
}
export type RemoteFailure =
	| "remote_configuration_invalid"
	| "remote_connection_failed"
	| "remote_registration_failed"
	| "remote_inspection_failed"
	| "remote_sessions_open"
	| "remote_local_closure_unproven"
	| "remote_query_failed";

export const failure = (code: RemoteFailure) =>
	new SqlError({ reason: new UnknownError({ cause: undefined, message: code, operation: "remote_session" }) });

/** Keep only categories used for conflict handling; driver text/constraint names can contain secrets. */
export const sanitizedCause = <E>(cause: Cause.Cause<E>, code: RemoteFailure) => {
	const only = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
	if (code === "remote_query_failed" && only && Cause.isFailReason(only) && isSqlError(only.error)) {
		const fields = { cause: undefined, message: code, operation: "remote_session" };
		switch (only.error.reason._tag) {
			case "UniqueViolation":
				return new SqlError({ reason: new UniqueViolation({ ...fields, constraint: "redacted" }) });
			case "DeadlockError":
				return new SqlError({ reason: new DeadlockError(fields) });
			case "SerializationError":
				return new SqlError({ reason: new SerializationError(fields) });
		}
	}
	return failure(code);
};

/** Driver causes and registration defects can contain credentials; never retain them. */
export const sanitized = <A, E, R>(effect: Effect.Effect<A, E, R>, code: RemoteFailure) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(sanitizedCause(cause, code)),
		),
	);

export const attemptTag = (options: RemoteAttempt) =>
	Effect.gen(function* () {
		const { connection, attempt } = options;
		if (
			!/^[a-f0-9]{64}$/.test(attempt) ||
			!connection.host ||
			!connection.database ||
			!connection.username ||
			!Redacted.value(connection.password) ||
			!Number.isSafeInteger(connection.port) ||
			connection.port < 1 ||
			connection.port > 65535
		)
			return yield* failure("remote_configuration_invalid");
		const bytes = Encoding.decodeHex(attempt);
		if (Result.isFailure(bytes)) return yield* failure("remote_configuration_invalid");
		// 49 printable characters, below PostgreSQL's 63-byte application_name limit.
		return `comms:${Encoding.encodeBase64Url(bytes.success)}`;
	});
