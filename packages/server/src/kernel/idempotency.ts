import { Clock, Crypto, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { EventRecord, KernelError } from "./boot-channel.ts";

export interface Idempotency<A> {
	readonly instance: string;
	readonly key: string;
	readonly kind: string;
	readonly input: string;
	readonly outcome: Schema.Codec<A, string>;
	readonly scope?: "operational";
}
const replayWindow = 30 * 24 * 60 * 60 * 1000;
const Stored = Schema.Struct({ kind: Schema.String, input_hash: Schema.String, outcome: Schema.String });
const hash = (crypto: Crypto.Crypto, input: string) =>
	crypto
		.digest("SHA-256", new TextEncoder().encode(input))
		.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
const keyFor = <A>(receipt: Idempotency<A>) => JSON.stringify([receipt.scope ?? "key", receipt.key]);
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
			sql`SELECT kind,input_hash,outcome FROM idempotency WHERE instance=${receipt.instance} AND key=${key}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Stored))),
				Effect.map((rows) => rows[0]),
			);
		const decode = (row: typeof Stored.Type) =>
			Effect.gen(function* () {
				if (row.kind !== receipt.kind || row.input_hash !== (yield* hash(crypto, receipt.input)))
					return yield* new KernelError({ code: "idempotency_conflict" });
				return Option.some(yield* Schema.decodeEffect(receipt.outcome)(row.outcome));
			});
		const current = yield* read(keyFor(receipt));
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
		const inputHash = yield* hash(crypto, receipt.input);
		const outcome = yield* Schema.encodeEffect(receipt.outcome)(value);
		const expires = (yield* Clock.currentTimeMillis) + replayWindow;
		yield* sql`INSERT INTO idempotency(instance,key,kind,input_hash,outcome,expires_at) VALUES(${receipt.instance},${keyFor(receipt)},${receipt.kind},${inputHash},${outcome},${expires})`;
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

const MessageOutcome = Schema.Struct({
	id: Schema.String,
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	instance: Schema.String,
	body: Schema.String,
	tags: Schema.Array(Schema.String),
	meta: Schema.JsonObject,
	created_at: Schema.Int,
	edited_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});
const MessageCreate = Schema.Struct({
	topic: Schema.String,
	body: Schema.String,
	tags: Schema.Array(Schema.String),
	meta: Schema.JsonObject,
});
const MessageChange = Schema.Struct({
	method: Schema.Literals(["PATCH", "DELETE"]),
	id: Schema.String,
	input: Schema.NullOr(
		Schema.Struct({
			body: Schema.optionalKey(Schema.String),
			tags: Schema.optionalKey(Schema.Array(Schema.String)),
			meta: Schema.optionalKey(Schema.JsonObject),
		}),
	),
});
const TopicChange = Schema.Struct({
	path: Schema.String,
	input: Schema.Union([Schema.Struct({ meta: Schema.JsonObject }), Schema.Struct({ archived: Schema.Boolean })]),
});
const TopicDelete = Schema.Struct({ path: Schema.String, delete: Schema.Literal(true) });
const TopicMove = Schema.Struct({ from: Schema.String, to: Schema.String, move: Schema.Literal(true) });
const TopicOutcome = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	seq: Schema.Int,
});
const DeletedTopic = Schema.Struct({ path: Schema.String, deleted_at: Schema.Int, seq: Schema.Int });
const MovedTopic = Schema.Struct({ from: Schema.String, to: Schema.String, seq: Schema.Int });
const ReactionOutcome = Schema.Struct({
	message: Schema.String,
	emoji: Schema.String,
	instance: Schema.String,
	active: Schema.Boolean,
	seq: Schema.Int,
});
const LegacyRow = Schema.Struct({
	instance: Schema.String,
	key: Schema.String,
	input: Schema.String,
	outcome: Schema.String,
});

/** Runs once under schema initialization's epoch-gated transaction; any malformed receipt rolls back all DDL. */
export const migrateIdempotency = (sql: SqlClient) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		yield* sql`ALTER TABLE idempotency RENAME TO idempotency_legacy`;
		yield* sql`CREATE TABLE idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,input_hash TEXT NOT NULL,outcome TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(instance,key))`;
		yield* sql`CREATE INDEX idempotency_expiry ON idempotency(expires_at)`;
		yield* sql`CREATE INDEX outbox_unshipped ON outbox(seq) WHERE shipped_at IS NULL`;
		yield* sql`CREATE INDEX outbox_transaction ON outbox(transaction_id,seq)`;
		// Historical commits have no timestamp. Adoption gives every imported outcome a full window.
		const expires = (yield* Clock.currentTimeMillis) + replayWindow;
		const insert = (instance: string, key: string, kind: string, input: string, outcome: string) =>
			Effect.gen(function* () {
				const inputHash = yield* hash(crypto, input);
				yield* sql`INSERT INTO idempotency(instance,key,kind,input_hash,outcome,expires_at) VALUES(${instance},${key},${kind},${inputHash},${outcome},${expires})`;
			});
		const messages = yield* sql`SELECT instance,key,input,outcome FROM idempotency_legacy`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyRow))),
		);
		for (const row of messages) {
			const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(row.input);
			yield* Schema.decodeEffect(Schema.fromJsonString(MessageOutcome))(row.outcome);
			let kind: string;
			if (Schema.is(MessageCreate)(input)) kind = "message.created";
			else {
				const change = yield* Schema.decodeUnknownEffect(MessageChange)(input);
				if ((change.method === "DELETE") !== (change.input === null))
					return yield* new KernelError({ code: "idempotency_migration_invalid" });
				kind = change.method === "DELETE" ? "message.deleted" : "message.edited";
			}
			yield* insert(row.instance, JSON.stringify(["legacy", "message", row.key]), kind, row.input, row.outcome);
		}
		const topics = yield* sql`SELECT instance,key,input,outcome FROM topic_idempotency`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LegacyRow))),
		);
		for (const row of topics) {
			const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(row.input);
			let kind: string;
			if (Schema.is(TopicDelete)(input)) {
				kind = "topic.deleted";
				yield* Schema.decodeEffect(Schema.fromJsonString(DeletedTopic))(row.outcome);
			} else if (Schema.is(TopicMove)(input)) {
				kind = "topic.moved";
				yield* Schema.decodeEffect(Schema.fromJsonString(MovedTopic))(row.outcome);
			} else {
				const change = yield* Schema.decodeUnknownEffect(TopicChange)(input);
				kind = "archived" in change.input ? "topic.archived" : "topic.meta";
				yield* Schema.decodeEffect(Schema.fromJsonString(TopicOutcome))(row.outcome);
			}
			yield* insert(row.instance, JSON.stringify(["legacy", "topic", row.key]), kind, row.input, row.outcome);
		}
		const reads = yield* sql`SELECT instance,key,topic,requested_seq,effective_seq FROM read_idempotency`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							instance: Schema.String,
							key: Schema.String,
							topic: Schema.String,
							requested_seq: Schema.Int,
							effective_seq: Schema.Int,
						}),
					),
				),
			),
		);
		for (const row of reads)
			yield* insert(
				row.instance,
				JSON.stringify(["legacy", "read", row.key]),
				"read.marked",
				JSON.stringify({ topic: row.topic, seq: row.requested_seq }),
				JSON.stringify({ topic: row.topic === "" ? "*" : row.topic, seq: row.effective_seq }),
			);
		const reactions = yield* sql`SELECT instance,key,message,emoji,outcome FROM reaction_idempotency`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							instance: Schema.String,
							key: Schema.String,
							message: Schema.String,
							emoji: Schema.String,
							outcome: Schema.String,
						}),
					),
				),
			),
		);
		for (const row of reactions) {
			yield* Schema.decodeEffect(Schema.fromJsonString(ReactionOutcome))(row.outcome);
			yield* insert(
				row.instance,
				JSON.stringify(["legacy", "reaction", row.key]),
				"reaction.added",
				JSON.stringify({ message: row.message, emoji: row.emoji }),
				row.outcome,
			);
		}
		const events =
			yield* sql`SELECT transaction_id,event FROM outbox WHERE substr(transaction_id,1,4)='ext:' ORDER BY seq`.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ transaction_id: Schema.String, event: Schema.String })),
					),
				),
			);
		for (const row of events) {
			const match = /^ext:([a-f0-9]{32}):[a-f0-9]{32}$/.exec(row.transaction_id);
			if (!match?.[1]) return yield* new KernelError({ code: "idempotency_migration_invalid" });
			const event = yield* Schema.decodeEffect(Schema.fromJsonString(EventRecord))(row.event);
			const receipt: Idempotency<typeof EventRecord.Type> = {
				instance: "",
				key: match[1],
				scope: "operational",
				kind: event.type,
				input: operationalInput(event),
				outcome: Schema.fromJsonString(EventRecord),
			};
			const previous = yield* lookupIdempotency(sql, crypto, receipt);
			if (Option.isNone(previous)) yield* insert("", keyFor(receipt), receipt.kind, receipt.input, row.event);
		}
		yield* sql`DROP TABLE idempotency_legacy`;
		yield* sql`DROP TABLE topic_idempotency`;
		yield* sql`DROP TABLE read_idempotency`;
		yield* sql`DROP TABLE reaction_idempotency`;
	});
