import type { MessagePatch } from "@comms/protocol/message-patch";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { mentionsIn } from "./message-mentions.ts";
import type { Mutate } from "../../kernel/mutate.ts";
import { Message, MessageInput } from "@comms/protocol/messages";
import { StoredMessage } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";

// Called under Messages' permit through SQL commit and immediate outbox publication.
export const mutateMessage = (
	sql: SqlClient,
	mutate: Mutate,
	boot: Pick<BootChannel["Service"], "generation">,
	identity: Identity,
	id: string,
	input: typeof MessagePatch.Type | null,
	key?: string,
) =>
	Effect.gen(function* () {
		if (
			!/^m_[a-z0-9]+$|^[1-9][0-9]*$/.test(id) ||
			(/^[0-9]+$/.test(id) && !Number.isSafeInteger(Number(id))) ||
			(key !== undefined && (key.length < 1 || key.length > 200)) ||
			(input !== null &&
				(Object.keys(input).length === 0 ||
					input.body === "" ||
					(input.body?.length ?? 0) > 65536 ||
					(input.tags?.length ?? 0) > 100 ||
					input.tags?.some((tag) => tag.length > 100)))
		)
			return yield* new KernelError({ code: "input_invalid" });
		const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
			method: input === null ? "DELETE" : "PATCH",
			id,
			input,
		});
		const now = (yield* DateTime.nowAsDate).getTime();
		return yield* mutate({
			...(key === undefined
				? {}
				: {
						idempotency: {
							instance: identity.instance,
							key,
							kind: input === null ? "message.deleted" : "message.edited",
							input: encoded,
							outcome: Schema.fromJsonString(Message),
						},
					}),
			body: (reserve) =>
				Effect.gen(function* () {
					const rows =
						yield* sql`SELECT * FROM messages WHERE id=${id} OR seq=${/^[0-9]+$/.test(id) ? Number(id) : -1}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredMessage))),
						);
					const previous = rows[0];
					if (!previous) return yield* new KernelError({ code: "message_not_found" });
					if (identity.kind !== "human" && identity.instance !== previous.instance)
						return yield* new KernelError({ code: "author_required" });

					const deleted =
						yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL AND (path=${previous.topic} OR substr(${previous.topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (deleted.length > 0) return yield* new KernelError({ code: "topic_not_found" });
					if (previous.deleted_at !== null) {
						if (input === null) {
							return { outcome: previous, events: [] };
						}
						return yield* new KernelError({ code: "message_not_found" });
					}
					const archived =
						yield* sql`SELECT path FROM topics WHERE archived_at IS NOT NULL AND (path=${previous.topic} OR substr(${previous.topic},1,length(path)+1)=path||'/') LIMIT 1`;
					if (archived.length > 0) return yield* new KernelError({ code: "topic_archived" });
					const message = input === null ? { ...previous, deleted_at: now } : { ...previous, ...input, edited_at: now };
					if (input !== null) {
						const content = yield* Schema.encodeEffect(Schema.fromJsonString(MessageInput))(message);
						if (new TextEncoder().encode(content).byteLength > 131072)
							return yield* new KernelError({ code: "input_invalid" });
					}
					const range = yield* reserve(1);
					const before = yield* Schema.encodeEffect(Schema.fromJsonString(Message))(previous);
					const tags = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(message.tags);
					const meta = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))(message.meta);
					yield* sql`UPDATE messages SET body=${message.body},tags=${tags},meta=${meta},edited_at=${message.edited_at},deleted_at=${message.deleted_at},updated_seq=${range.from},previous=${before},previous_mentions=mentions,mentions=${JSON.stringify(mentionsIn(message.body))} WHERE id=${previous.id}`;
					const event = {
						seq: range.from,
						at: now,
						type: input === null ? "message.deleted" : "message.edited",
						level: "info" as const,
						actor: identity.agent,
						instance: identity.instance,
						generation: boot.generation,
						request_id: identity.request,
						topic: previous.topic,
						message_id: previous.id,
						payload: message,
					};
					return { outcome: message, events: [event] };
				}),
		});
	});
