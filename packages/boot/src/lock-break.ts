import { committed, captureRefusal } from "./auth-primitives.ts";
import { Clock, Effect, Result, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import { EditLock, EditRejected } from "./edit-lock.ts";
import type { AssertionProof } from "./enrollment.ts";
import { validLockId, type BreakLock } from "./lock-break-schema.ts";

/** Fresh proof, live session, observed lock and audit event share the boot transaction. */
export const makeLockBreak = <E, R>(
	verify: (params: BreakLock, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const lock = yield* EditLock;
		return (params: BreakLock, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validLockId(params.id)) return yield* new AuthError({ code: "invalid_request" });
						yield* verify(params, proof);
						const now = yield* Clock.currentTimeMillis;
						const session = yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`;
						if (!session.length) return yield* new AuthError({ code: "session_invalid" });
						const outcome = yield* lock
							.breakLock(params.id, { agent: "rahul", instance: sessionId })
							.pipe(captureRefusal(Schema.is(EditRejected)));
						return outcome;
					}).pipe(
						captureRefusal(Schema.is(AuthError)),
						Effect.map((result) => Result.flatMap(result, (outcome) => outcome)),
					),
				).pipe(Effect.map((result) => result.value)),
			);
	});
