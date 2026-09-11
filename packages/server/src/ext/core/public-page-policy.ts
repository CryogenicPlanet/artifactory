import { DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, type EventRecord, KernelError } from "../../kernel/boot-channel.ts";
import { Lifecycle } from "../../kernel/lifecycle.ts";
import { publishedTopics } from "./published-topics.ts";
import { Messages } from "./messages.ts";

const pagePath = (name: string) =>
	name !== "" &&
	!/[\\:]/.test(name) &&
	Array.from(name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
	name
		.split("/")
		.every(
			(part) =>
				part !== "" &&
				part !== "." &&
				part !== ".." &&
				part !== "node_modules" &&
				part !== ".vite" &&
				!part.startsWith(".comms-"),
		);
const PublicPaths = Schema.Struct({ paths: Schema.Array(Schema.String) });

/** Replace all published grants in one event before admitting this child. Never run in rehearsal. */
export const reconstructPublicPages = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const messages = yield* Messages;
	if ((yield* Lifecycle).initial === "rehearsal") return yield* new KernelError({ code: "generation_not_live" });
	yield* messages.mutate({
		idempotency: {
			instance: "",
			scope: "operational",
			key: `pages.public:${boot.epoch}`,
			kind: "pages.public",
			input: boot.epoch,
			outcome: Schema.fromJsonString(Schema.Int),
		},
		body: (reserve) =>
			Effect.gen(function* () {
				const ceiling = (yield* boot.fence).published_through;
				const rows = yield* sql`WITH current_topics AS (${publishedTopics(sql, ceiling)})
			 SELECT path FROM current_topics topic WHERE deleted_at IS NULL AND json_type(meta,'$.public')='true'
			 AND NOT EXISTS (SELECT 1 FROM current_topics ancestor WHERE ancestor.deleted_at IS NOT NULL
			 AND (ancestor.path=topic.path OR substr(topic.path,1,length(ancestor.path)+1)=ancestor.path||'/'))
			 ORDER BY path LIMIT 4097`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
				);
				// Refuse overflow before filtering unsafe paths: a truncated query must never publish an incomplete set.
				if (rows.length > 4096) return yield* new KernelError({ code: "public_pages_limit" });
				const payload = { paths: rows.map((row) => row.path).filter(pagePath) };
				const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PublicPaths))(payload);
				// The append transport allows 1 MiB; this leaves space for its one-event envelope.
				if (Buffer.byteLength(encoded) > 524288) return yield* new KernelError({ code: "public_pages_limit" });
				const range = yield* reserve(1);
				const event = {
					seq: range.from,
					at: (yield* DateTime.nowAsDate).getTime(),
					type: "pages.public",
					level: "info",
					actor: "system",
					instance: null,
					generation: boot.generation,
					request_id: null,
					topic: null,
					message_id: null,
					payload,
				} satisfies typeof EventRecord.Type;
				return { outcome: range.from, events: [event] };
			}),
	});
}).pipe(
	Effect.mapError((error) => (error._tag === "KernelError" ? error : new KernelError({ code: "boot_unavailable" }))),
	Effect.tapError((error) => (error.code === "public_pages_limit" ? Effect.logError(error) : Effect.void)),
);
