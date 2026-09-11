import { type Crypto, DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, EventRecord, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { type Identity, validTopic } from "./messages.ts";

export const TopicMetaInput = Schema.Struct({ meta: Schema.JsonObject });
export const TopicArchiveInput = Schema.Struct({ archived: Schema.Boolean });
export const TopicMutation = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	seq: Schema.Int,
});
const StoredTopic = Schema.Struct({
	deleted_at: Schema.NullOr(Schema.Int),
	path: Schema.String,
	meta: Schema.fromJsonString(Schema.JsonObject),
	archived_at: Schema.NullOr(Schema.Int),
	updated_seq: Schema.Int,
});

// The caller holds Messages' permit through commit and immediate publication.
export const mutateTopic = <E>(
	sql: SqlClient,
	crypto: Crypto.Crypto,
	boot: BootChannel["Service"],
	relay: Effect.Effect<void, E>,
	identity: Identity,
	path: string,
	input: typeof TopicMetaInput.Type | typeof TopicArchiveInput.Type,
	key?: string,
) =>
	Effect.gen(function* () {
		if (!validTopic(path) || (key !== undefined && (key.length < 1 || key.length > 200)))
			return yield* new KernelError({ code: "input_invalid" });
		const archive = "archived" in input;
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({ path, input });
		if (Buffer.byteLength(encoded) > 131072) return yield* new KernelError({ code: "input_invalid" });
		yield* relay;
		const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
		const now = (yield* DateTime.nowAsDate).getTime();
		let reservedCount = 0;
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					if (key !== undefined) {
						const receipts =
							yield* sql`SELECT input,outcome FROM topic_idempotency WHERE instance=${identity.instance} AND key=${key}`.pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(
										Schema.Array(Schema.Struct({ input: Schema.String, outcome: Schema.String })),
									),
								),
							);
						if (receipts[0]) {
							if (receipts[0].input !== encoded) return yield* new KernelError({ code: "idempotency_conflict" });
							return yield* Schema.decodeEffect(Schema.fromJsonString(TopicMutation))(receipts[0].outcome);
						}
					}
					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${path} OR substr(${path},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length) return yield* new KernelError({ code: "topic_not_found" });
					const rows =
						yield* sql`SELECT path,meta,archived_at,deleted_at,updated_seq FROM topics WHERE path=${path}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredTopic))),
						);
					const previous = rows[0];
					if (archive && !previous) return yield* new KernelError({ code: "topic_not_found" });
					const archived =
						yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${path} OR substr(${path},1,length(path)+1)=path||'/') AND (${archive ? 1 : 0}=0 OR path<>${path}) LIMIT 1`;
					if (archived.length) return yield* new KernelError({ code: "topic_archived" });
					const parts = path.split("/");
					const missing: Array<{ path: string; parent: string | null; name: string }> = [];
					for (let i = 0; i < parts.length; i++) {
						const ancestor = parts.slice(0, i + 1).join("/");
						if ((yield* sql`SELECT path FROM topics WHERE path=${ancestor}`).length === 0)
							missing.push({
								path: ancestor,
								parent: i === 0 ? null : parts.slice(0, i).join("/"),
								name: parts[i] ?? "",
							});
					}
					reservedCount = missing.length + 1;
					const range = yield* boot.reserve(transaction, reservedCount);
					const event = (seq: number, type: string, topic: string, payload: Schema.JsonObject) => ({
						seq,
						at: now,
						type,
						level: "info" as const,
						actor: identity.agent,
						instance: identity.instance,
						generation: boot.generation,
						request_id: identity.request,
						topic,
						message_id: null,
						payload,
					});
					const records: Array<typeof EventRecord.Type> = [];
					for (const [index, topic] of missing.entries()) {
						const seq = range.from + index;
						yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq) VALUES(${topic.path},${topic.parent},${topic.name},'{}',${seq},${now},${seq})`;
						records.push(event(seq, "topic.created", topic.path, topic));
					}
					const outcome = {
						path,
						meta: "meta" in input ? input.meta : (previous?.meta ?? {}),
						archived_at:
							"archived" in input
								? input.archived
									? (previous?.archived_at ?? now)
									: null
								: (previous?.archived_at ?? null),
						seq: range.to,
					};
					const before = previous
						? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
								meta: previous.meta,
								archived_at: previous.archived_at,
								deleted_at: previous.deleted_at,
							})
						: null;
					const meta = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(outcome.meta);
					yield* sql`UPDATE topics SET meta=${meta},archived_at=${outcome.archived_at},updated_seq=${range.to},previous=${before} WHERE path=${path}`;
					records.push(event(range.to, archive ? "topic.archived" : "topic.meta", path, outcome));
					yield* sql`INSERT INTO mutation_batches VALUES(${transaction},${range.from},${range.to},${records.length})`;
					for (const record of records) {
						const json = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(record);
						yield* sql`INSERT INTO outbox VALUES(${record.seq},${transaction},${json},NULL)`;
					}
					if (key !== undefined) {
						const json = yield* Schema.encodeEffect(Schema.fromJsonString(TopicMutation))(outcome);
						yield* sql`INSERT INTO topic_idempotency VALUES(${identity.instance},${key},${encoded},${json})`;
					}
					return outcome;
				}),
			)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			// Typed failure proves rollback; commit/rollback defects remain for fenced recovery.
			if (reservedCount > 0) {
				yield* boot.reserve(transaction, reservedCount);
				yield* boot.abort(transaction);
			}
			return yield* result.failure;
		}
		yield* relay;
		return result.success;
	}).pipe(Effect.uninterruptible);
