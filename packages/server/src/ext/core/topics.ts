import { TopicSummary } from "@comms/protocol/topics";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelError } from "../../kernel/boot-channel.ts";

import { Messages, StoredMessage, validTopic } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";
import { publishedTopics } from "./published-topics.ts";
import { publishedMessages } from "./published-messages.ts";
import { Pages } from "./pages.ts";

const StoredTopic = Schema.Struct({ ...TopicSummary.fields, meta: Schema.fromJsonString(Schema.JsonObject) });
export const makeTopics = (sql: SqlClient.SqlClient, read: Messages["Service"]["read"], pages: Pages["Service"]) => {
	const detail = (identity: Identity, path: string, depth = 1, archived = false) =>
		read((ceiling) =>
			Effect.gen(function* () {
				if (path !== "" && !validTopic(path)) return yield* new KernelError({ code: "input_invalid" });
				const page = yield* pages.topic(path, depth);
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SELECT epoch FROM kernel_writer`;

						const rows =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}), visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT t.path,t.name,t.meta,t.archived_at,
   COALESCE((SELECT MAX(m.seq) FROM visible_messages m WHERE m.seq<=${ceiling} AND (m.topic=t.path OR substr(m.topic,1,length(t.path)+1)=t.path||'/')),0) AS last_seq,
   (SELECT COUNT(*) FROM visible_messages m WHERE m.deleted_at IS NULL AND m.seq<=${ceiling} AND (m.topic=t.path OR substr(m.topic,1,length(t.path)+1)=t.path||'/')
    AND NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (m.topic=a.path OR substr(m.topic,1,length(a.path)+1)=a.path||'/'))
    AND m.seq>COALESCE((SELECT MAX(r.seq) FROM reads r WHERE r.instance=${identity.instance} AND (r.topic='' OR r.topic=m.topic OR substr(m.topic,1,length(r.topic)+1)=r.topic||'/')),0)) AS unread
   FROM visible_topics t WHERE NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.deleted_at IS NOT NULL AND (t.path=a.path OR substr(t.path,1,length(a.path)+1)=a.path||'/')) AND (${path}='' OR t.path=${path} OR substr(t.path,1,length(${path})+1)=${path + "/"})
   AND (${archived ? 1 : 0}=1 OR t.path=${path} OR NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (t.path=a.path OR substr(t.path,1,length(a.path)+1)=a.path||'/')))
   ORDER BY last_seq DESC,t.path`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredTopic))));
						const deletedTopics =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path FROM visible_topics WHERE deleted_at IS NOT NULL`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
							);
						if (deletedTopics.some((row) => path === row.path || path.startsWith(`${row.path}/`)))
							return yield* new KernelError({ code: "topic_not_found" });
						const visible = [...rows];
						const archivedTopics =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path FROM visible_topics WHERE archived_at IS NOT NULL`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
							);
						for (const directory of page.directories) {
							if (
								visible.some((row) => row.path === directory) ||
								deletedTopics.some((row) => directory === row.path || directory.startsWith(`${row.path}/`)) ||
								(!archived &&
									archivedTopics.some((row) => directory === row.path || directory.startsWith(`${row.path}/`)))
							)
								continue;
							visible.push({
								path: directory,
								name: directory.split("/").at(-1) ?? directory,
								meta: {},
								last_seq: 0,
								unread: 0,
								archived_at: null,
							});
						}
						visible.sort((a, b) => b.last_seq - a.last_seq || a.path.localeCompare(b.path));
						const own = visible.find((row) => row.path === path);
						if (path !== "" && !own && !page.exists) return yield* new KernelError({ code: "topic_not_found" });
						const segments = path === "" ? 0 : path.split("/").length;
						const subtopics = visible.filter(
							(row) => row.path !== path && row.path.split("/").length <= segments + depth,
						);
						const recent =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}), visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT * FROM visible_messages WHERE deleted_at IS NULL AND (${path}='' OR topic=${path}) AND seq<=${ceiling} AND (${path}<>'' OR NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (visible_messages.topic=a.path OR substr(visible_messages.topic,1,length(a.path)+1)=a.path||'/'))) ORDER BY seq DESC LIMIT 100`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredMessage))),
							);
						return {
							path,
							meta: own?.meta ?? {},
							archived_at: own?.archived_at ?? null,
							archived_by:
								archivedTopics
									.filter((row) => path === row.path || path.startsWith(`${row.path}/`))
									.sort((left, right) => left.path.length - right.path.length)[0]?.path ?? null,
							subtopics,
							messages: [...recent].reverse(),
							fence: ceiling,
							unread:
								own?.unread ?? rows.filter((row) => !row.path.includes("/")).reduce((sum, row) => sum + row.unread, 0),
							index: page.index,
							pages: page.pages,
						};
					}),
				);
			}),
		);
	return { detail };
};
const make = Effect.gen(function* () {
	return makeTopics(yield* SqlClient.SqlClient, (yield* Messages).read, yield* Pages);
});
export class Topics extends Context.Service<Topics, Effect.Success<typeof make>>()("comms/server/Topics") {}
export const layer = Layer.effect(Topics, make);
