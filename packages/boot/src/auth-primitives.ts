import { type Crypto, Effect, Result } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";

export const refuse = (code: AuthError["code"]) => Effect.fail(new AuthError({ code }));

/** Capture the owning service's Crypto implementation, never credentials or mutable state. */
export const authSecrets = (crypto: Crypto.Crypto) => ({
	hash: (value: string) =>
		crypto
			.digest("SHA-256", new TextEncoder().encode(value))
			.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex"))),
	random: crypto.randomBytes(32).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("base64url"))),
});

/** Capture only a single semantic failure. A combined failure still rolls back the transaction. */
export const captureRefusal =
	<D>(matches: (error: unknown) => error is D) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Result.Result<A, D>, E, R> =>
		effect.pipe(
			Effect.map((value): Result.Result<A, D> => Result.succeed(value)),
			Effect.catchCause((cause): Effect.Effect<Result.Result<A, D>, E> => {
				const reason = cause.reasons[0];
				return cause.reasons.length === 1 && reason?._tag === "Fail" && matches(reason.error)
					? Effect.succeed(Result.fail(reason.error))
					: Effect.failCause(cause);
			}),
		);

/** The caller places captureRefusal at the exact proof boundary it owns.
 * Semantic results fail after COMMIT; errors, defects and interruption still roll back. */
export const committed = <A, D, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<Result.Result<A, D>, E, R>) =>
	sql.withTransaction(effect).pipe(Effect.flatMap(Effect.fromResult));
