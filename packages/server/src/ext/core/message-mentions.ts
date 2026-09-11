import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

export const mentionsIn = (body: string): ReadonlyArray<string> => {
	const targets = new Set<string>();
	for (const match of body.matchAll(/(?:^|[\s([])(@[a-z0-9][a-z0-9._/-]*)(?![/._-])(?=$|[\s\p{P}])/gu)) {
		const target = match[1];
		if (target && target.length <= 200 && /^@[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(target))
			targets.add(target);
	}
	return [...targets];
};

/** Keep both images searchable during an unpublished edit, like messages_fts. */
export const initializeMentions = (sql: SqlClient) =>
	Effect.gen(function* () {
		yield* sql`ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`;
		yield* sql`ALTER TABLE messages ADD COLUMN previous_mentions TEXT NOT NULL DEFAULT '[]'`;
		const rows = yield* sql`SELECT id,body,json_extract(previous,'$.body') AS previous_body FROM messages`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({ id: Schema.String, body: Schema.String, previous_body: Schema.NullOr(Schema.String) }),
					),
				),
			),
		);
		for (const row of rows)
			yield* sql`UPDATE messages SET mentions=${JSON.stringify(mentionsIn(row.body))},previous_mentions=${JSON.stringify(mentionsIn(row.previous_body ?? ""))} WHERE id=${row.id}`;
	});
