import { Clock, type Crypto, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type EventRecord } from "@comms/protocol/events";
import { KernelError } from "./boot-channel.ts";

export interface Idempotency<A> {
	readonly instance: string;
	readonly key: string;
	readonly kind: string;
	readonly input: string;
	readonly outcome: Schema.Codec<A, string>;
	readonly scope?: "operational";
}
export const idempotencyReplayWindow = 30 * 24 * 60 * 60 * 1000;
const Stored = Schema.Struct({ kind: Schema.String, input_hash: Schema.String, outcome: Schema.String });
export const idempotencyInputHash = (crypto: Crypto.Crypto, input: string) =>
	crypto
		.digest("SHA-256", new TextEncoder().encode(input))
		.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
export const idempotencyKey = <A>(receipt: Idempotency<A>) => JSON.stringify([receipt.scope ?? "key", receipt.key]);
const families = ["message", "topic", "read", "reaction"] as const;
const familyFor = (kind: string) => {
	switch (kind) {
		case "message.created":
		case "message.edited":
		case "message.deleted":
			return "message";
		case "topic.meta":
		case "topic.archived":
		case "topic.deleted":
		case "topic.moved":
			return "topic";
		case "read.marked":
			return "read";
		case "reaction.added":
			return "reaction";
		default:
			return undefined;
	}
};

/** Caller holds the SQL writer transaction, beginning with its epoch gate. */
export const lookupIdempotency = <A>(sql: SqlClient, crypto: Crypto.Crypto, receipt: Idempotency<A>) =>
	Effect.gen(function* () {
		const read = (key: string) =>
			sql`SELECT kind,input_hash,outcome FROM idempotency WHERE instance=${receipt.instance} AND ${sql("key")}=${key}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Stored))),
				Effect.map((rows) => rows[0]),
			);
		const decode = (row: typeof Stored.Type) =>
			Effect.gen(function* () {
				if (row.kind !== receipt.kind || row.input_hash !== (yield* idempotencyInputHash(crypto, receipt.input)))
					return yield* new KernelError({ code: "idempotency_conflict" });
				return Option.some(yield* Schema.decodeEffect(receipt.outcome)(row.outcome));
			});
		const current = yield* read(idempotencyKey(receipt));
		if (current) return yield* decode(current);
		if (receipt.scope === "operational") return Option.none<A>();
		const family = familyFor(receipt.kind);
		if (family) {
			const previous = yield* read(JSON.stringify(["legacy", family, receipt.key]));
			if (previous) return yield* decode(previous);
		}
		// Historical families could legally share a key. Keep their outcomes, but never add another use.
		for (const other of families) {
			if (other !== family && (yield* read(JSON.stringify(["legacy", other, receipt.key]))))
				return yield* new KernelError({ code: "idempotency_conflict" });
		}
		return Option.none<A>();
	});

/** Insert only after lookup in the same writer transaction; the primary key rejects competing receipts. */
export const storeIdempotency = <A>(sql: SqlClient, crypto: Crypto.Crypto, receipt: Idempotency<A>, value: A) =>
	Effect.gen(function* () {
		const inputHash = yield* idempotencyInputHash(crypto, receipt.input);
		const outcome = yield* Schema.encodeEffect(receipt.outcome)(value);
		const expires = (yield* Clock.currentTimeMillis) + idempotencyReplayWindow;
		yield* sql`INSERT INTO idempotency(instance,${sql("key")},kind,input_hash,outcome,expires_at) VALUES(${receipt.instance},${idempotencyKey(receipt)},${receipt.kind},${inputHash},${outcome},${expires})`;
	});

export const operationalInput = (
	event: Pick<
		typeof EventRecord.Type,
		"type" | "level" | "payload" | "actor" | "instance" | "request_id" | "generation"
	>,
) =>
	JSON.stringify({
		type: event.type,
		level: event.level,
		payload: event.payload,
		actor: event.actor,
		instance: event.instance,
		request_id: event.request_id,
		generation: event.generation,
	});
