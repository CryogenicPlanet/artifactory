import { Cause, Effect, type Redacted, Schema } from "effect";
import {
	SqlError,
	UnknownError,
	UniqueViolation,
	DeadlockError,
	SerializationError,
	isSqlError,
} from "effect/unstable/sql/SqlError";

/** Configured names only; driver text and credentials never escape a failed login. */
export class RemoteConnectionRejected extends Schema.TaggedError<RemoteConnectionRejected>()(
	"RemoteConnectionRejected",
	{
		code: Schema.Literals(["remote_database_unavailable", "remote_role_rejected", "remote_connection_failed"]),
		database: Schema.String,
		role: Schema.String,
	},
) {
	override get message() {
		return `${this.code}: configured database ${JSON.stringify(this.database)}, role ${JSON.stringify(this.role)}. Require an existing database and a role allowed to connect; chirp does not provision them.`;
	}
}

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
export type RemoteFailure =
	| "remote_writer_busy"
	| "remote_configuration_invalid"
	| "remote_connection_failed"
	| "remote_isolation_unsupported"
	| "remote_query_failed";

export const failure = (code: RemoteFailure) =>
	new SqlError({ reason: new UnknownError({ cause: undefined, message: code, operation: "remote_session" }) });

/** Keep only categories used for conflict handling; driver text/constraint names can contain secrets. */
export const sanitizedCause = <E>(cause: Cause.Cause<E>, code: RemoteFailure) => {
	const only = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
	if (
		only &&
		Cause.isFailReason(only) &&
		isSqlError(only.error) &&
		only.error.reason.operation === "remote_session" &&
		only.error.reason.message === "remote_isolation_unsupported"
	)
		return failure("remote_isolation_unsupported");
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

/** Driver causes and defects can contain credentials; never retain them. */
export const sanitized = <A, E, R>(effect: Effect.Effect<A, E, R>, code: RemoteFailure) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(sanitizedCause(cause, code)),
		),
	);
