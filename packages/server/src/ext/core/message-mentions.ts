import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export const mentionsIn = (body: string): ReadonlyArray<string> => {
	const targets = new Set<string>();
	for (const match of body.matchAll(/(?<![\p{L}\p{N}\p{M}@])(@[a-z0-9][a-z0-9._/-]*)(?![/._-])(?=$|[\s\p{P}|])/gu)) {
		// Consume the whole path before trimming punctuation; never backtrack to a valid prefix.
		const target = match[1]?.replace(/[._-]+$/u, "");
		if (target && target.length <= 200 && /^@[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(target))
			targets.add(target);
	}
	return [...targets];
};

/** Rebuild only derived search fields, including the retained unpublished before-image. */
export const reindexMentions = (sql: SqlClient) =>
	Effect.gen(function* () {
		let after: string | null = null;
		while (true) {
			const rows: ReadonlyArray<{ readonly id: string; readonly body: string; readonly previous_body: string | null }> =
				yield* sql`SELECT id,body,json_extract(previous,'$.body') AS previous_body FROM messages WHERE ${after} IS NULL OR id > ${after} ORDER BY id LIMIT 256`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(
								Schema.Struct({
									id: Schema.String,
									body: Schema.String,
									previous_body: Schema.NullOr(Schema.String),
								}),
							),
						),
					),
				);
			if (rows.length === 0) return;
			for (const row of rows) {
				yield* sql`UPDATE messages SET mentions=${JSON.stringify(mentionsIn(row.body))},previous_mentions=${JSON.stringify(mentionsIn(row.previous_body ?? ""))} WHERE id=${row.id}`;
				after = row.id;
			}
		}
	});

/** Keep both images searchable during an unpublished edit, like messages_fts. */
export const initializeMentions = (sql: SqlClient) =>
	Effect.gen(function* () {
		yield* sql`ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`;
		yield* sql`ALTER TABLE messages ADD COLUMN previous_mentions TEXT NOT NULL DEFAULT '[]'`;
		yield* reindexMentions(sql);
	});
