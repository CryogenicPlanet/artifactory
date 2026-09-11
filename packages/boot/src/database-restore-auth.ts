import { Clock, Crypto, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import { captureRefusal, committed, canonicalProof } from "./auth-primitives.ts";
import type { AssertionProof } from "./enrollment.ts";
import {
	DatabaseRestoreRequest,
	validRestoreSelection,
	type RestoreSelection,
	type RestoreTarget,
} from "./database-restore-schema.ts";

/** Resolve catalog metadata only. Filesystem ownership/inventory is checked by the coordinator. */
export const resolveRestoreTarget = (params: RestoreSelection) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		let id: string;
		if ("backup" in params) id = params.backup;
		else {
			const generation =
				(yield* sql`SELECT good,snapshot_dir,backup_id FROM generations WHERE n=${params.generation}`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(
								Schema.Struct({
									good: Schema.Int,
									snapshot_dir: Schema.NullOr(Schema.String),
									backup_id: Schema.NullOr(Schema.String),
								}),
							),
						),
					),
				))[0];
			if (!generation || generation.good !== 1 || generation.snapshot_dir === null)
				return yield* new AuthError({ code: "generation_not_restorable" });
			if (generation.backup_id === null) return yield* new AuthError({ code: "backup_not_restorable" });
			id = generation.backup_id;
		}
		const backup = (yield* sql`SELECT published_through FROM backups WHERE id=${id}`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ published_through: Schema.NullOr(Schema.Int) }))),
			),
		))[0];
		if (!backup) return yield* new AuthError({ code: "backup_not_found" });
		if (
			backup.published_through === null ||
			!Number.isSafeInteger(backup.published_through) ||
			backup.published_through < 0
		)
			return yield* new AuthError({ code: "backup_not_restorable" });
		return { backup: id, published_through: backup.published_through };
	});
const sameSelection = (receipt: DatabaseRestoreRequest, params: RestoreSelection) =>
	"backup" in params
		? receipt.source_generation === null && receipt.backup === params.backup
		: receipt.source_generation === params.generation;

/** Authorization and receipt are durable before the coordinator touches any runtime or file. */
export const makeDatabaseRestoreAuth = <E, R>(
	verify: (
		params: RestoreSelection,
		proof: AssertionProof,
		sessionId: string,
		target: RestoreTarget | null,
	) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		return (params: RestoreSelection, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validRestoreSelection(params)) return yield* new AuthError({ code: "invalid_request" });
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
							if (!sameSelection(receipt, params) || receipt.idempotency_key !== (params.idempotency_key ?? null))
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
								if (!sameSelection(saved, params)) return yield* new AuthError({ code: "idempotency_conflict" });
								// Reading a prior authorization does not consume a different challenge or start another operation.
								return saved;
							}
						}
						const target =
							"backup" in params
								? null
								: yield* resolveRestoreTarget(params).pipe(Effect.provideService(SqlClient.SqlClient, sql));
						yield* verify(params, proof, sessionId, target);
						yield* liveSession;
						if (
							(yield* sql`SELECT proof_id FROM db_restore_requests WHERE phase IN ('authorized','restoring','working','rollback') LIMIT 1`)
								.length
						)
							return yield* new AuthError({ code: "restore_in_progress" });
						const backup =
							target ?? (yield* resolveRestoreTarget(params).pipe(Effect.provideService(SqlClient.SqlClient, sql)));
						const request: DatabaseRestoreRequest = {
							proof_id: proof.id,
							idempotency_key: params.idempotency_key ?? null,
							proof_hash: proofHash,
							session_id: sessionId,
							backup: backup.backup,
							phase: "authorized",
							safety_backup: null,
							generation: null,
							source_generation: "generation" in params ? params.generation : null,
							prior_generation: null,
							source_batch: null,
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
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);
	});
