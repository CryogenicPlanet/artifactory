import { Clock, Effect, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import { EditLock, EditRejected } from "./edit-lock.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { validLockId, type BreakLock } from "./lock-break-schema.ts";

/** Fresh proof, live session, observed lock and audit event share the boot transaction. */
export const makeLockBreak = <E, R>(
	verify: (params: BreakLock, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const lock = yield* EditLock;
		const events = yield* Events;
		return (params: BreakLock, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				sql
					.withTransaction(
						Effect.gen(function* () {
							if (!validLockId(params.id)) return yield* new AuthError({ code: "invalid_request" });
							yield* verify(params, proof);
							const now = yield* Clock.currentTimeMillis;
							const session = yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`;
							if (!session.length) return yield* new AuthError({ code: "session_invalid" });
							const outcome = yield* lock
								.breakLock(params.id)
								.pipe(Effect.catchIf(Schema.is(EditRejected), Effect.succeed));
							for (const transition of outcome.transitions)
								yield* events.writeBoot({
									at: now,
									type: `lock.${transition.type}`,
									level: "info",
									actor: "rahul",
									instance: sessionId,
									generation: 0,
									request_id: null,
									topic: null,
									message_id: null,
									payload: { ...transition },
								});
							return outcome;
						}).pipe(Effect.catchIf(Schema.is(AuthError), Effect.succeed)),
					)
					.pipe(
						// Consume valid proofs on semantic refusals; SQL/event failures roll everything back.
						// oxlint-disable-next-line effecttsgo/flat-map-conditional-to-filter-or-fail
						Effect.flatMap((result) =>
							Schema.is(AuthError)(result) || Schema.is(EditRejected)(result)
								? Effect.fail(result)
								: Effect.succeed(result.value),
						),
					),
			);
	});
