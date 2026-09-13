import { lockBootWrite } from "./boot-write-lock.ts";
import { type Crypto, Effect, Result } from "effect";
import type { AssertionProof } from "./enrollment.ts";
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
	sql.withTransaction(lockBootWrite(sql).pipe(Effect.andThen(effect))).pipe(Effect.flatMap(Effect.fromResult));

/** Stable assertion bytes bind durable receipts across retries and boot upgrades. */
export const canonicalProof = (proof: AssertionProof) =>
	JSON.stringify([
		proof.id,
		proof.response.id,
		proof.response.rawId,
		proof.response.type,
		proof.response.response.clientDataJSON,
		proof.response.response.authenticatorData,
		proof.response.response.signature,
		proof.response.response.userHandle ?? null,
	]);

/** Diagnostic compatibility filter for lowercase 64-hex values, not general credential redaction. */
export const redactHex = (text: string) => text.replace(/[a-f0-9]{64}/g, "[redacted]");
