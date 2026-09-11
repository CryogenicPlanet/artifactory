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
				yield* sql`INSERT INTO reads(instance,topic,seq) VALUES(${identity.instance},${input.topic},${input.seq}) ON CONFLICT(instance,topic) DO UPDATE SET seq=excluded.seq WHERE reads.seq<excluded.seq`;
				return { outcome: undefined, events: [] };
			}),
	});
