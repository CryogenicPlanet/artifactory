import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import type { AssertionProof } from "./enrollment.ts";
import { DatabaseRestoreRequest, validDatabaseRestore, type DatabaseRestore } from "./database-restore-schema.ts";

const canonicalProof = (proof: AssertionProof) =>
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

/** Authorization and receipt are durable before the coordinator touches any runtime or file. */
export const makeDatabaseRestoreAuth = <E, R>(
	verify: (params: DatabaseRestore, proof: AssertionProof, sessionId: string) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		return (params: DatabaseRestore, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				sql
					.withTransaction(
						Effect.gen(function* () {
							if (!validDatabaseRestore(params)) return yield* new AuthError({ code: "invalid_request" });
							const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(canonicalProof(proof)));
							const proofHash = Buffer.from(digest).toString("hex");
							const liveSession = Effect.gen(function* () {
								const now = yield* Clock.currentTimeMillis;
								if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
									return yield* new AuthError({ code: "session_invalid" });
							});
							const receipt = (yield* sql`SELECT * FROM db_restore_requests WHERE proof_id=${proof.id}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DatabaseRestoreRequest))),
							))[0];
							if (receipt) {
								yield* liveSession;
								if (receipt.session_id !== sessionId || receipt.proof_hash !== proofHash)
									return yield* new AuthError({ code: "assertion_invalid" });
								if (receipt.backup !== params.backup || receipt.idempotency_key !== (params.idempotency_key ?? null))
									return yield* new AuthError({ code: "idempotency_conflict" });
								return receipt;
							}
							if (params.idempotency_key !== undefined) {
								yield* liveSession;
								const saved =
									(yield* sql`SELECT * FROM db_restore_requests WHERE session_id=${sessionId} AND idempotency_key=${params.idempotency_key}`.pipe(
										Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DatabaseRestoreRequest))),
									))[0];
								if (saved) {
									if (saved.backup !== params.backup) return yield* new AuthError({ code: "idempotency_conflict" });
									// Reading a prior authorization does not consume a different challenge or start another operation.
									return saved;
								}
							}
							yield* verify(params, proof, sessionId);
							yield* liveSession;
							if (
								(yield* sql`SELECT proof_id FROM db_restore_requests WHERE phase IN ('authorized','restoring','working','rollback') LIMIT 1`)
									.length
							)
								return yield* new AuthError({ code: "restore_in_progress" });
							const backup = (yield* sql`SELECT published_through FROM backups WHERE id=${params.backup}`.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(
										Schema.Array(Schema.Struct({ published_through: Schema.NullOr(Schema.Int) })),
									),
								),
							))[0];
							if (!backup) return yield* new AuthError({ code: "backup_not_found" });
							if (backup.published_through === null || backup.published_through < 0)
								return yield* new AuthError({ code: "backup_not_restorable" });
							const request: DatabaseRestoreRequest = {
								proof_id: proof.id,
								idempotency_key: params.idempotency_key ?? null,
								proof_hash: proofHash,
								session_id: sessionId,
								backup: params.backup,
								phase: "authorized",
								safety_backup: null,
								generation: null,
								restored_to_seq: backup.published_through,
								event_seq: null,
								failure: null,
								lock_id: null,
								lock_family: null,
								lock_owned: 0,
								candidate_epoch: null,
							};
							yield* sql`INSERT INTO db_restore_requests ${sql.insert(request)}`;
							return request;
						}).pipe(Effect.catchIf(Schema.is(AuthError), Effect.succeed)),
					)
					.pipe(
						// Semantic refusals consume valid proofs; SQL failure rolls back proof and receipt together.
						// oxlint-disable-next-line effecttsgo/flat-map-conditional-to-filter-or-fail
						Effect.flatMap((result) => (Schema.is(AuthError)(result) ? Effect.fail(result) : Effect.succeed(result))),
					),
			);
	});
