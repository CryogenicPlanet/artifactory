import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Mutate } from "../../kernel/mutate.ts";
import type { Identity } from "../../kernel/identity.ts";

export const ReadInput = Schema.Struct({ topic: Schema.String, seq: Schema.Int });
export const ReadResult = ReadInput;
export const effectiveCursor = (sql: SqlClient, instance: string, topic: string) =>
	sql`SELECT COALESCE(MAX(seq),0) AS seq FROM reads WHERE instance=${instance} AND
 (topic=${topic} OR ${topic === "~inbox" ? 0 : 1}=1 AND (topic='' OR substr(${topic},1,length(topic)+1)=topic||'/'))`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
		Effect.map((rows) => rows[0]?.seq ?? 0),
	);

// Returned messages already prove the publication ceiling. View metadata has no event or receipt.
export const markRead = (sql: SqlClient, mutate: Mutate, identity: Identity, input: typeof ReadInput.Type) =>
	mutate({
		body: () =>
			Effect.gen(function* () {
				yield* sql`INSERT INTO reads(instance,topic,seq) VALUES(${identity.instance},${input.topic},${input.seq}) ON CONFLICT(instance,topic) DO UPDATE SET seq=excluded.seq WHERE reads.seq<excluded.seq`;
				return { outcome: undefined, events: [] };
			}),
	});
