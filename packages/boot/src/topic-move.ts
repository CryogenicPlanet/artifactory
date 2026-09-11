import { recoveryIntents } from "./recovery-intents.ts";
import { Cause, Crypto, Effect, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { AppRecovery } from "./app-recovery.ts";
import type { ChildAttempts } from "./child-attempts.ts";
import { ChildError } from "./child-process.ts";
import type { VerifiedIdentity } from "./enrollment.ts";
import { Events } from "./events.ts";
import type { Generations } from "./generations.ts";
import type { Supervisor } from "./supervisor.ts";
import { TopicPageMove } from "./topic-page-move.ts";
import { TopicMoveError, TopicMoveRow, validMovePath } from "./topic-move-schema.ts";

export interface MoveRequest {
	readonly from: string;
	readonly to: string;
	readonly key?: string;
}
const Outcome = Schema.Struct({ from: Schema.String, to: Schema.String, seq: Schema.Int });
const Rejection = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
export const topicMove = Effect.fn("topicMove")(function* (supervisor: Supervisor) {
	const sql = yield* SqlClient.SqlClient;
	const events = yield* Events;
	const pages = yield* TopicPageMove;
	const recovery = yield* AppRecovery;
	const crypto = yield* Crypto.Crypto;
	const client = yield* HttpClient.HttpClient;
	const context = yield* Effect.context<Generations | AppRecovery | ChildAttempts>();
	const move = <E>(input: MoveRequest, revalidate: Effect.Effect<VerifiedIdentity, E>) =>
		supervisor.operationGate.withPermit(
			Effect.gen(function* () {
				if (
					!validMovePath(input.from) ||
					!validMovePath(input.to) ||
					input.from === input.to ||
					input.to.startsWith(`${input.from}/`) ||
					input.from.startsWith(`${input.to}/`)
				)
					return yield* new TopicMoveError({ code: "input_invalid" });
				const identity = yield* revalidate.pipe(
					Effect.mapError(() => new TopicMoveError({ code: "credential_invalid" })),
				);
				if (!identity.scopes.includes("write")) return yield* new TopicMoveError({ code: "scope_required" });
				const hash = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Struct({ from: Schema.String, to: Schema.String })),
				)({ from: input.from, to: input.to });
				if (input.key !== undefined) {
					const previous =
						yield* sql`SELECT * FROM topic_moves WHERE instance=${identity.id} AND request_key=${input.key} AND state<>'aborted'`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TopicMoveRow))),
						);
					if (previous[0]) {
						const row = previous[0];
						if (row.request_hash !== hash) return yield* new TopicMoveError({ code: "idempotency_conflict" });
						if (row.state !== "completed" || row.seq === null)
							return yield* new TopicMoveError({ code: "topic_move_recovery_required" });
						yield* pages.finish(row.id);
						return { from: row.from_path, to: row.to_path, seq: row.seq };
					}
				}
				yield* supervisor.assertClosure;
				if ((yield* recoveryIntents(sql)).count > 0)
					return yield* new TopicMoveError({ code: "topic_move_recovery_required" });
				const active = yield* Ref.get(supervisor.current);
				const route = yield* Ref.get(supervisor.child.traffic.route);
				if (!active || route?.epoch !== active.attempt.epoch || route.state !== "live")
					return yield* new ChildError({ code: "live_child_required" });
				const transaction = yield* crypto.randomUUIDv4;
				let closed = false;
				let stable = false;
				const retire = Effect.gen(function* () {
					yield* Ref.set(supervisor.current, null);
					yield* Ref.set(supervisor.child.traffic.route, null);
					if (!closed) {
						yield* supervisor.retire(active).pipe(Effect.provideContext(context));
						closed = true;
					}
				});
				yield* supervisor.child.traffic.requests.freeze;
				const outcome = yield* Effect.gen(function* () {
					// Draining terminates existing app long polls; frozen retains the narrow move-command permission.
					yield* active.process.control("draining");
					yield* supervisor.child.traffic.requests.drained.pipe(Effect.timeout("5 seconds"));
					yield* active.process.control("frozen");
					stable = true;
					yield* recovery.prepare(active.attempt.epoch);
					const current = yield* revalidate.pipe(
						Effect.mapError(() => new TopicMoveError({ code: "credential_invalid" })),
					);
					if (current.id !== identity.id || !current.scopes.includes("write"))
						return yield* new TopicMoveError({ code: "scope_required" });
					if (
						(yield* sql`SELECT seq FROM events WHERE (topic=${input.from} OR substr(topic,1,length(${input.from})+1)=${input.from}||'/')
					AND length(topic)-length(${input.from})+length(${input.to})>200 LIMIT 1`).length
					)
						return yield* new TopicMoveError({ code: "input_invalid" });
					yield* sql`INSERT INTO topic_moves(id,from_path,to_path,instance,request_key,request_hash,state)
					VALUES(${transaction},${input.from},${input.to},${identity.id},${input.key ?? null},${hash},'prepared')`;
					const prepared = yield* pages.prepare(transaction, input.from, input.to, identity.agent);
					const authorized = yield* revalidate.pipe(
						Effect.mapError(() => new TopicMoveError({ code: "credential_invalid" })),
					);
					if (
						authorized.id !== identity.id ||
						authorized.agent !== identity.agent ||
						authorized.kind !== identity.kind ||
						!authorized.scopes.includes("write")
					)
						return yield* new TopicMoveError({ code: "scope_required" });
					yield* supervisor.child.channelGate.withPermit(events.reserve(transaction, 1, active.attempt.epoch));
					stable = false;
					const response = yield* client.execute(
						HttpClientRequest.post(`http://127.0.0.1:${active.process.port}/_kernel/topic-move`).pipe(
							HttpClientRequest.setHeader("x-boot-secret", active.attempt.secret),
							HttpClientRequest.bodyJsonUnsafe({
								transaction,
								...(input.key === undefined ? {} : { key: input.key }),
								from: input.from,
								to: input.to,
								page_source: prepared.page_source,
								identity: {
									agent: identity.agent,
									instance: identity.id,
									request: transaction,
									kind: identity.kind,
									label: identity.label,
								},
							}),
						),
					);
					const value = yield* response.json;
					if (response.status !== 200) {
						const rejection = yield* Schema.decodeUnknownEffect(Rejection)(value);
						stable = true;
						return yield* new TopicMoveError({ code: rejection.error.code });
					}
					yield* Schema.decodeUnknownEffect(Outcome)(value);
					stable = true;
					// The app's committed outbox, not its HTTP response, authorizes page publication and success.
					yield* recovery.prepare(active.attempt.epoch);
					const rows = yield* sql`SELECT * FROM topic_moves WHERE id=${transaction}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TopicMoveRow))),
					);
					const row = rows[0];
					if (row?.state !== "completed" || row.seq === null)
						return yield* new TopicMoveError({ code: "topic_move_evidence_invalid" });
					return { from: row.from_path, to: row.to_path, seq: row.seq };
				}).pipe(Effect.timeout("20 seconds"), Effect.interruptible, Effect.exit);
				// A canceled request/control is not closure evidence. Fence only after the keeper closes its owner.
				if (!stable) yield* retire;
				const resolved = yield* recovery.prepare(active.attempt.epoch).pipe(Effect.exit);
				if (resolved._tag === "Failure") {
					yield* Ref.set(
						supervisor.child.sourceError,
						Cause.pretty(resolved.cause).replace(/[a-f0-9]{64}/g, "[redacted]"),
					);
					yield* retire;
					yield* supervisor.fail(resolved.cause);
					return yield* Effect.failCause(resolved.cause);
				}
				yield* supervisor.assertClosure;
				if (closed) yield* supervisor.start(active.generation).pipe(Effect.provideContext(context));
				else
					yield* active.process
						.control("live")
						.pipe(
							Effect.catch(() =>
								retire.pipe(Effect.andThen(supervisor.start(active.generation).pipe(Effect.provideContext(context)))),
							),
						);
				yield* supervisor.child.traffic.requests.release;
				if (outcome._tag === "Failure") return yield* Effect.failCause(outcome.cause);
				return outcome.value;
			}).pipe(Effect.uninterruptible),
		);
	return { move };
});
export type TopicMove = Effect.Success<ReturnType<typeof topicMove>>;
