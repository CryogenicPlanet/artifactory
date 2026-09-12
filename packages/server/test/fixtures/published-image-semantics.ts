import { strict as assert } from "node:assert";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { publishedMessages } from "../../src/ext/core/published-messages.ts";
import { publishedTopics } from "../../src/ext/core/published-topics.ts";

export const publishedImageSemantics = (sql: SqlClient) =>
	Effect.gen(function* () {
		const previousTopic = '{"meta":{"stage":"previous"},"archived_at":null,"deleted_at":null}';
		const previousMessage =
			'{"body":"previous","tags":["previous","null"],"meta":{"stage":"previous","nullable":null},"edited_at":null,"deleted_at":null}';
		yield* sql`INSERT INTO topics(path,parent,name,meta,previous,last_seq,created_at,updated_seq) VALUES('json-probe',NULL,'json-probe','{"stage":"live"}',${previousTopic},30,0,30)`;
		yield* sql`INSERT INTO messages(id,seq,topic,agent,instance,created_at,body,tags,meta,previous,updated_seq,edited_at,deleted_at) VALUES('json-probe',5,'json-probe','test','test',0,'live','["live"]','{"stage":"live","nullable":null}',${previousMessage},30,1,NULL)`;
		for (const [ceiling, stage] of [
			[20, "previous"],
			[30, "live"],
		] as const) {
			const messages =
				yield* sql`SELECT body,tags,meta,edited_at FROM (${publishedMessages(sql, ceiling)}) visible WHERE id='json-probe'`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(
								Schema.Struct({
									body: Schema.String,
									tags: Schema.fromJsonString(Schema.Array(Schema.String)),
									meta: Schema.fromJsonString(Schema.Json),
									edited_at: Schema.NullOr(Schema.Int),
								}),
							),
						),
					),
				);
			assert.deepEqual(messages, [
				{
					body: stage,
					tags: stage === "previous" ? ["previous", "null"] : ["live"],
					meta: { stage, nullable: null },
					edited_at: stage === "previous" ? null : 1,
				},
			]);
			const topics =
				yield* sql`SELECT meta FROM (${publishedTopics(sql, ceiling)}) visible WHERE path='json-probe'`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ meta: Schema.fromJsonString(Schema.Json) }))),
					),
				);
			assert.deepEqual(topics, [{ meta: { stage } }]);
		}
	});
