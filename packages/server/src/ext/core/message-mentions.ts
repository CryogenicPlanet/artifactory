import { jsonText, nullable } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export const mentionsIn = (body: string): ReadonlyArray<string> => {
	const targets = new Set<string>();
	for (const match of body.matchAll(/(?<![\p{L}\p{N}\p{M}@/:])(@[a-z0-9][a-z0-9._/-]*)(?![\p{L}\p{N}\p{M}@/._-])/gu)) {
		// Consume the whole path before trimming punctuation; never backtrack to a valid prefix.
		const target = match[1]?.replace(/[._-]+$/u, "");
		if (target && target.length <= 200 && /^@[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(target))
			targets.add(target);
	}
	return [...targets];
};

/** Rebuild only derived search fields, including the retained unpublished before-image. */
const reconcileMentions = (sql: SqlClient, repair: boolean) =>
	Effect.gen(function* () {
		let after: string | null = null;
		while (true) {
			const rows: ReadonlyArray<{
				readonly id: string;
				readonly body: string;
				readonly previous_body: string | null;
				readonly mentions: string;
				readonly previous_mentions: string;
			}> =
				yield* sql`SELECT id,body,${jsonText(sql, sql("previous"), "body")} AS previous_body,mentions,previous_mentions FROM messages WHERE ${nullable(sql, after)} IS NULL OR id > ${after} ORDER BY id LIMIT 256`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(
								Schema.Struct({
									id: Schema.String,
									body: Schema.String,
									previous_body: Schema.NullOr(Schema.String),
									mentions: Schema.String,
									previous_mentions: Schema.String,
								}),
							),
						),
					),
				);
			if (rows.length === 0) return true;
			for (const row of rows) {
				const mentions = JSON.stringify(mentionsIn(row.body));
				const previous = JSON.stringify(mentionsIn(row.previous_body ?? ""));
				if (row.mentions !== mentions || row.previous_mentions !== previous) {
					if (!repair) return false;
					yield* sql`UPDATE messages SET mentions=${mentions},previous_mentions=${previous} WHERE id=${row.id}`;
				}
				after = row.id;
			}
		}
	});

export const reindexMentions = (sql: SqlClient) => reconcileMentions(sql, true).pipe(Effect.asVoid);
export const mentionsCurrent = (sql: SqlClient) => reconcileMentions(sql, false);

/** Keep both images searchable during an unpublished edit, like messages_fts. */
export const initializeMentions = (sql: SqlClient) =>
	Effect.gen(function* () {
		yield* sql`ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`;
		yield* sql`ALTER TABLE messages ADD COLUMN previous_mentions TEXT NOT NULL DEFAULT '[]'`;
		yield* reindexMentions(sql);
	});
