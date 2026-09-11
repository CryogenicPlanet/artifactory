import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { publishedTopics } from "./published-topics.ts";

const pageWritePath = (value: string) =>
	value.startsWith("pages/") &&
	value.length <= 4096 &&
	!/[\\:]/.test(value) &&
	Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
	value
		.split("/")
		.every(
			(part) =>
				part !== "" &&
				part !== "." &&
				part !== ".." &&
				part !== "node_modules" &&
				part !== ".vite" &&
				!part.startsWith(".comms-"),
		);
export const PageWriteCheck = Schema.Struct({
	paths: Schema.Array(Schema.String.pipe(Schema.check(Schema.makeFilter(pageWritePath)))).pipe(
		Schema.check(Schema.isMaxLength(256)),
	),
	published_through: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const PageWriteDecision = Schema.Union([
	Schema.Struct({ allowed: Schema.Literal(true) }),
	Schema.Struct({
		allowed: Schema.Literal(false),
		code: Schema.Literals(["topic_deleted", "topic_archived"]),
		path: Schema.String,
	}),
]);
export class PageWriteUnavailable extends Schema.TaggedError<PageWriteUnavailable>()("PageWriteUnavailable", {}) {}

/** Boot holds publication admission. Use an independent reader: never acquire the app writer or call boot here. */
export const checkPageWrites = (filename: string, epoch: string, input: typeof PageWriteCheck.Type) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const writers = yield* sql`SELECT epoch FROM kernel_writer WHERE singleton=1`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ epoch: Schema.String })))),
				);
				if (writers.length !== 1 || writers[0]?.epoch !== epoch) return yield* new PageWriteUnavailable({});
				for (const path of input.paths) {
					const relative = path.slice("pages/".length);
					const rows = yield* sql`WITH visible_topics AS (${publishedTopics(sql, input.published_through)})
				 SELECT archived_at,deleted_at FROM visible_topics WHERE path=${relative} OR substr(${relative},1,length(path)+1)=path||'/'`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({ archived_at: Schema.NullOr(Schema.Int), deleted_at: Schema.NullOr(Schema.Int) }),
								),
							),
						),
					);
					if (rows.some((row) => row.deleted_at !== null))
						return { allowed: false, code: "topic_deleted", path } satisfies typeof PageWriteDecision.Type;
					if (rows.some((row) => row.archived_at !== null))
						return { allowed: false, code: "topic_archived", path } satisfies typeof PageWriteDecision.Type;
				}
				return { allowed: true } satisfies typeof PageWriteDecision.Type;
			}),
		);
	}).pipe(
		Effect.provide(SqliteClient.layer({ filename, readonly: true, disableWAL: true, busyTimeout: "100 millis" })),
		Effect.scoped,
		Effect.mapError(() => new PageWriteUnavailable({})),
	);
