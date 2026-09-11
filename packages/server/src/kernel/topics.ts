import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { Message, Messages, StoredMessage, validTopic, type Identity } from "./messages.ts";
import { publishedTopics } from "./published-topics.ts";
import { publishedMessages } from "./published-messages.ts";
import { Pages } from "./pages.ts";
import { effectiveCursor } from "./read-marks.ts";

export const TopicSummary = Schema.Struct({
	path: Schema.String,
	name: Schema.String,
	meta: Schema.JsonObject,
	last_seq: Schema.Int,
	unread: Schema.Int,
	archived_at: Schema.NullOr(Schema.Int),
});
export const TopicResult = Schema.Struct({
	path: Schema.String,
	meta: Schema.JsonObject,
	archived_at: Schema.NullOr(Schema.Int),
	archived_by: Schema.NullOr(Schema.String),
	subtopics: Schema.Array(TopicSummary),
	messages: Schema.Array(Message),
	cursor: Schema.Int,
	unread: Schema.Int,
	index: Schema.NullOr(Schema.String),
	pages: Schema.Array(Schema.String),
});
const StoredTopic = Schema.Struct({ ...TopicSummary.fields, meta: Schema.fromJsonString(Schema.JsonObject) });
const mentionMatches = (body: string, agentHome: string | null, instanceHome: string | null) => {
	for (const match of body.matchAll(/(?:^|[\s([])(@[a-z0-9][a-z0-9._/-]*)(?![/._-])(?=$|[\s\p{P}])/gu)) {
		const target = match[1];
		if (target && validTopic(target) && (target === "@here" || target === agentHome || target === instanceHome))
			return true;
	}
	return false;
};
const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const messages = yield* Messages;
	const pages = yield* Pages;
	const detail = (identity: Identity, path: string, depth = 1, archived = false) =>
		Effect.gen(function* () {
			if (path !== "" && !validTopic(path)) return yield* new KernelError({ code: "query_invalid" });
			const page = yield* pages.topic(path, depth);
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`SELECT epoch FROM kernel_writer`;
					const ceiling = (yield* messages.fence).published_through;
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
						cursor: ceiling,
						unread:
							own?.unread ?? rows.filter((row) => !row.path.includes("/")).reduce((sum, row) => sum + row.unread, 0),
						index: page.index,
						pages: page.pages,
					};
				}),
			);
		});
	const inbox = (
		identity: Identity,
		since: number,
		limit: number,
		mode: "agent" | "instance" = "agent",
		maxScan = Number.POSITIVE_INFINITY,
	) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`SELECT epoch FROM kernel_writer`;
				const ceiling = (yield* messages.fence).published_through;
				if (since > ceiling) return yield* new KernelError({ code: "query_invalid" });
				const agentHome = mode === "agent" ? `@${identity.agent}` : null;
				const instanceHome =
					identity.label !== undefined &&
					/^[a-z0-9][a-z0-9._-]*$/.test(identity.label) &&
					validTopic(`@${identity.agent}/${identity.label}`)
						? `@${identity.agent}/${identity.label}`
						: null;
				const home = agentHome ?? instanceHome;
				let scanned = since;
				let scannedRows = 0;
				const items: Array<typeof Message.Type> = [];
				while (items.length < limit && scannedRows < maxScan) {
					const batch =
						yield* sql`WITH visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT * FROM visible_messages WHERE deleted_at IS NULL AND seq>${scanned} AND seq<=${ceiling} AND instance<>${identity.instance} ORDER BY seq LIMIT ${Math.min(200, maxScan - scannedRows)}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredMessage))),
						);
					for (const message of batch) {
						scanned = message.seq;
						scannedRows++;
						if (
							(home !== null && (message.topic === home || message.topic.startsWith(`${home}/`))) ||
							mentionMatches(message.body, agentHome, instanceHome)
						)
							items.push(message);
						if (items.length === limit) break;
					}
					if (batch.length < 200) break;
				}
				return {
					items,
					cursor: items.at(-1)?.seq ?? since,
					timed_out: false,
					drained: false,
					...(Number.isFinite(maxScan) ? { scan_truncated: scannedRows >= maxScan } : {}),
				};
			}),
		);
	return { detail, inbox, cursor: (identity: Identity) => effectiveCursor(sql, identity.instance, "~inbox") };
});
export class Topics extends Context.Service<Topics, Effect.Success<typeof make>>()("comms/server/Topics") {}
export const layer = Layer.effect(Topics, make);
