import { Crypto, DateTime, Effect, Ref, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { Lifecycle } from "./lifecycle.ts";

export interface OperationalEvent {
	/** Stable diagnostic key; each database attempt gets a separate reservation ID. */
	readonly transaction: string;
	readonly type: string;
	readonly level: "info" | "error";
	readonly payload: Schema.JsonObject;
	readonly actor?: string;
	readonly instance?: string;
	readonly request?: string;
}

// Called under the existing Messages permit, through commit and immediate publication.
export const recordOperationalEvent = <E, E2 = never>(
	sql: SqlClient,
	boot: BootChannel["Service"],
	relay: Effect.Effect<void, E>,
	input: OperationalEvent,
	change: (seq: number) => Effect.Effect<void, E2> = () => Effect.void,
) =>
	Effect.gen(function* () {
		const lifecycle = yield* Lifecycle;
		if ((yield* Ref.get(lifecycle.state)) !== "live") return yield* new KernelError({ code: "generation_not_live" });
		const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(input.payload);
		if (
			!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.type) ||
			input.type === "topic.moved" ||
			!/^[a-f0-9]{32}$/.test(input.transaction) ||
			new TextEncoder().encode(payload).length > 65536
		)
			return yield* new KernelError({ code: "input_invalid" });
		yield* relay;
		const crypto = yield* Crypto.Crypto;
		const prefix = `ext:${input.transaction}:`;
		const transaction = prefix + Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
		let reserved = false;
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					// Retained outbox batches are also the receipt; aborted attempts leave no row here.
					const previous =
						yield* sql`SELECT event FROM outbox WHERE substr(transaction_id,1,${prefix.length})=${prefix}`.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.fromJsonString(EventRecord) }))),
							),
						);
					if (previous.length > 0) {
						const event = previous[0]?.event;
						const previousPayload = event
							? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(event.payload)
							: null;
						if (
							previous.length !== 1 ||
							!event ||
							event.type !== input.type ||
							event.level !== input.level ||
							event.generation !== boot.generation ||
							event.actor !== (input.actor ?? "system") ||
							event.instance !== (input.instance ?? null) ||
							event.request_id !== (input.request ?? null) ||
							previousPayload !== payload
						)
							return yield* new KernelError({ code: "idempotency_conflict" });
						return event;
					}
					reserved = true;
					const range = yield* boot.reserve(transaction, 1);
					const event = {
						seq: range.from,
						at: (yield* DateTime.nowAsDate).getTime(),
						type: input.type,
						level: input.level,
						actor: input.actor ?? "system",
						instance: input.instance ?? null,
						generation: boot.generation,
						request_id: input.request ?? null,
						topic: null,
						message_id: null,
						payload: input.payload,
					};
					yield* change(range.from);
					const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(event);
					yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},1)`;
					yield* sql`INSERT INTO outbox VALUES(${range.from},${transaction},${encoded},NULL)`;
					return event;
				}),
			)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			// A typed failure confirms rollback; uncertain commit/rollback defects remain for recovery.
			if (reserved) {
				yield* boot.reserve(transaction, 1);
				yield* boot.abort(transaction);
			}
			return yield* Effect.fail(result.failure);
		}
		yield* relay;
		return result.success;
	}).pipe(Effect.uninterruptible);
