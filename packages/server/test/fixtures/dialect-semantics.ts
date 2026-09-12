import { strict as assert } from "node:assert";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import * as dialect from "@comms/storage/dialect";

/** Execute fragments against the selected native driver, including values SQL string assertions cannot check. */
export const dialectSemantics = (sql: SqlClient) =>
	Effect.gen(function* () {
		const flags = yield* sql`SELECT
		 CASE WHEN ${dialect.isDescendant(sql, "a%_*/child", "a%_*")} THEN 1 ELSE 0 END AS descendant,
		 CASE WHEN ${dialect.isDescendant(sql, "anything/child", "a%_*")} THEN 1 ELSE 0 END AS unrelated,
		 CASE WHEN ${dialect.isDescendant(sql, "a/child", "a")} THEN 1 ELSE 0 END AS child,
		 CASE WHEN ${dialect.isDescendant(sql, "ab/child", "a")} THEN 1 ELSE 0 END AS boundary,
		 CASE WHEN ${dialect.isDescendant(sql, "a", "a")} THEN 1 ELSE 0 END AS self,
		 CASE WHEN ${dialect.globPrefix(sql, "é😀abc", "é😀")} THEN 1 ELSE 0 END AS unicode,
		 CASE WHEN ${dialect.globPrefix(sql, "ABC", "a")} THEN 1 ELSE 0 END AS case_sensitive,
		 CASE WHEN ${dialect.globPrefix(sql, "a%_*?[x", "a%_*?[")} THEN 1 ELSE 0 END AS literal,
		 CASE WHEN ${dialect.jsonArrayHas(sql, '["a","b","b"]', "b")} THEN 1 ELSE 0 END AS member,
		 CASE WHEN ${dialect.jsonArrayHas(sql, "[]", "b")} THEN 1 ELSE 0 END AS empty_array,
		 CASE WHEN ${dialect.jsonArrayHas(sql, '["null",null]', "null")} THEN 1 ELSE 0 END AS null_string_member,
		 CASE WHEN ${dialect.distinctFrom(sql, null, null)} THEN 1 ELSE 0 END AS same,
		 CASE WHEN ${dialect.distinctFrom(sql, "a", null)} THEN 1 ELSE 0 END AS different,
		 CASE WHEN ${dialect.distinctFrom(sql, "a", "a")} THEN 1 ELSE 0 END AS equal_text`;
		assert.deepEqual(flags, [
			{
				descendant: 1,
				unrelated: 0,
				child: 1,
				boundary: 0,
				self: 0,
				unicode: 1,
				case_sensitive: 0,
				literal: 1,
				member: 1,
				empty_array: 0,
				null_string_member: 1,
				same: 0,
				different: 1,
				equal_text: 0,
			},
		]);
		// GREATEST is polymorphic: typed numeric operands match production cursor columns.
		// PGlite otherwise infers two unconstrained bound parameters as text.
		const values = yield* sql`SELECT
		 ${dialect.replacePrefix(sql, "é😀/child", "é😀", "new")} AS replaced,
		 ${dialect.jsonText(sql, '{"body":"null"}', "body")} AS body,
		 ${dialect.jsonText(sql, '{"body":null}', "body")} AS json_null,
		 ${dialect.jsonText(sql, "{}", "body")} AS missing,
		 ${dialect.jsonInt(sql, '{"deleted_at":null}', "deleted_at")} AS deleted_at,
		 ${dialect.jsonInt(sql, '{"edited_at":42}', "edited_at")} AS edited_at,
		 ${dialect.jsonInt(sql, '{"seq":9007199254740991}', "seq")} AS safe_integer,
		 ${dialect.jsonInt(sql, '{"seq":-42}', "seq")} AS negative,
		 ${dialect.greatest(sql, sql`12`, sql`4`)} AS greatest`;
		assert.deepEqual(values, [
			{
				replaced: "new/child",
				body: "null",
				json_null: null,
				missing: null,
				deleted_at: null,
				edited_at: 42,
				safe_integer: Number.MAX_SAFE_INTEGER,
				negative: -42,
				greatest: 12,
			},
		]);
	});
