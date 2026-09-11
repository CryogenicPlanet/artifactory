import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Batch } from "./events.ts";
import { TopicPageMove } from "./topic-page-move.ts";
import { TopicMoveError, TopicMoveRow } from "./topic-move-schema.ts";

const rows = Effect.gen(function* () {
	return yield* (yield* SqlClient.SqlClient)`SELECT * FROM topic_moves WHERE state<>'aborted'`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TopicMoveRow))),
	);
});
/** Called after the authoritative app fence/evidence transaction, before every boot append. */
export const moveRecovery = Object.freeze({
	beforeAppend: (batch: Batch) =>
		Effect.gen(function* () {
			if (!batch.events.some((event) => event.type === "topic.moved")) return;
			const sql = yield* SqlClient.SqlClient;
			const found = (yield* rows).find((row) => row.id === batch.transaction);
			const event = batch.events[0];
			if (!found || batch.events.length !== 1 || !event || event.type !== "topic.moved")
				return yield* new TopicMoveError({ code: "topic_move_intent_missing" });
			const payload = yield* Schema.decodeUnknownEffect(Schema.Struct({ from: Schema.String, to: Schema.String }))(
				event.payload,
			);
			if (payload.from !== found.from_path || payload.to !== found.to_path || event.instance !== found.instance)
				return yield* new TopicMoveError({ code: "topic_move_evidence_invalid" });
			yield* (yield* TopicPageMove).publish(found.id);
			yield* sql`UPDATE topic_moves SET state='pages_published',seq=${batch.to} WHERE id=${found.id} AND state='prepared'`;
		}),
	/** No pending reservation remains. Prepared intents therefore have no committed app evidence. */
	afterResolve: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const pages = yield* TopicPageMove;
		for (const row of yield* rows) {
			if (row.state === "completed") yield* pages.finish(row.id);
			else if (row.state === "prepared") {
				yield* pages.abort(row.id);
				yield* sql`UPDATE topic_moves SET state='aborted' WHERE id=${row.id}`;
			} else return yield* new TopicMoveError({ code: "topic_move_publication_missing" });
		}
	}),
});
