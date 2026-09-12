import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Mutate } from "../../kernel/mutate.ts";
import type { Identity } from "../../kernel/identity.ts";

export const ReadInput = Schema.Struct({ topic: Schema.String, seq: Schema.Int });
export const ReadResult = ReadInput;
// Returned messages already prove the publication ceiling. View metadata has no event or receipt.
export const markRead = (sql: SqlClient, mutate: Mutate, identity: Identity, input: typeof ReadInput.Type) =>
	mutate({
		body: () =>
			Effect.gen(function* () {
				yield* sql`INSERT INTO ${sql("reads")}(instance,topic,seq) VALUES(${identity.instance},${input.topic},${input.seq}) ${on(sql, { sqlite: () => sql`ON CONFLICT(instance,topic) DO UPDATE SET seq=excluded.seq WHERE reads.seq<excluded.seq`, pg: () => sql`ON CONFLICT(instance,topic) DO UPDATE SET seq=excluded.seq WHERE reads.seq<excluded.seq`, mysql: () => sql`ON DUPLICATE KEY UPDATE seq=GREATEST(seq,${input.seq})` })}`;
				return { outcome: undefined, events: [] };
			}),
	});
