import { strict as assert } from "node:assert";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { on, readTransaction } from "@comms/storage/dialect";
import { markRead } from "../../src/ext/core/read-marks.ts";
import { makeTopics } from "../../src/ext/core/topics.ts";
import { Pages } from "../../src/ext/core/pages.ts";
import { assertSqlPublished } from "../../src/kernel/sql-publication.ts";
import type { Mutate } from "../../src/kernel/mutate.ts";

/** Execute the real cursor write, unread query and publication guard, not duplicated SQL. */
export const cursorPublicationSemantics = (sql: SqlClient, mutate: Mutate) =>
	Effect.gen(function* () {
		const identity = { agent: "test", instance: "cursor-probe", request: "probe", kind: "agent" as const };
		const pages = yield* Pages.pipe(
			Effect.provide(
				Layer.mock(Pages, {
					topic: () => Effect.succeed({ exists: false, index: null, pages: [], directories: [] }),
					render: () => {
						throw new Error("Unexpected page rendering");
					},
					move: { prepare: () => Effect.die("Unexpected page move"), finish: () => Effect.die("Unexpected page move") },
				}),
			),
		);
		const topics = makeTopics(sql, (callback) => readTransaction(sql, callback(30)), pages);
		assert.equal((yield* topics.detail(identity, "json-probe")).unread, 1);
		for (const seq of [5, 2, 8]) yield* markRead(sql, mutate, identity, { topic: "json-probe", seq });
		assert.deepEqual(yield* sql`SELECT topic,seq FROM ${sql("reads")} WHERE instance='cursor-probe'`, [
			{ topic: "json-probe", seq: 8 },
		]);
		assert.equal((yield* topics.detail(identity, "json-probe")).unread, 0);
		yield* sql`ALTER TABLE kernel_writer ADD COLUMN singleton INTEGER NOT NULL DEFAULT 1`;
		yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,event TEXT NOT NULL)`;
		const check = (epoch: string, ceiling: number) => readTransaction(sql, assertSqlPublished(sql, epoch, ceiling));
		const refused = (epoch: string, ceiling: number, code: string) =>
			Effect.gen(function* () {
				const result = yield* check(epoch, ceiling).pipe(Effect.result);
				assert.equal(result._tag, "Failure");
				if (result._tag === "Failure") {
					assert.equal(result.failure._tag, "KernelError");
					if (result.failure._tag === "KernelError") assert.equal(result.failure.code, code);
				}
			});
		yield* check("fixture", 20);
		yield* sql`INSERT INTO outbox VALUES(21,'{"type":"message.created"}'),(22,'{"type":null}')`;
		yield* check("fixture", 20);
		yield* sql`INSERT INTO outbox VALUES(30,'{"type":"sql.write"}')`;
		yield* refused("fixture", 20, "sql_publication_pending");
		yield* check("fixture", 30);
		yield* refused("stale", 30, "stale_writer");
		yield* on(sql, {
			sqlite: () => sql`SELECT 1`,
			pg: () => sql`ALTER TABLE outbox ALTER COLUMN event TYPE JSONB USING event::jsonb`,
			mysql: () => sql`ALTER TABLE outbox MODIFY event JSON NOT NULL`,
		});
		yield* refused("fixture", 20, "sql_publication_pending");
		yield* check("fixture", 30);
	});
