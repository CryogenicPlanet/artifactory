import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "../../src/client.ts";
import { isDescendant } from "../../src/dialect.ts";

const rows = await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE paths(child TEXT COLLATE NOCASE, ancestor TEXT COLLATE NOCASE)`;
		for (const [child, ancestor] of [
			["guide/child", "guide"],
			["guide", "guide"],
			["guide-other/child", "guide"],
			["", ""],
			["guide", ""],
			["/guide", ""],
			["日本語/é/child", "日本語/é"],
			["éclair/child", "é"],
			["a%b/child", "a%b"],
			["axb/child", "a%b"],
			["a_b/child", "a_b"],
			["axb/child", "a_b"],
			["a'b/child", "a'b"],
			["Guide/child", "guide"],
			["a*/child", "a*"],
			["abc/child", "a*"],
		])
			yield* sql`INSERT INTO paths VALUES(${child},${ancestor})`;
		return yield* sql`SELECT child,ancestor,${isDescendant(sql, sql`child`, sql`ancestor`)} AS matched FROM paths ORDER BY rowid`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ child: Schema.String, ancestor: Schema.String, matched: Schema.Int })),
				),
			),
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					sql`SELECT ${isDescendant(sql, sql`${row.child}`, sql`${row.ancestor}`)} AS matched`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ matched: Schema.Int })))),
						Effect.map((bound) => ({ ...row, bound: bound[0]?.matched })),
					),
				),
			),
		);
	}).pipe(Effect.provide(clientLayer({ _tag: "file", filename: ":memory:" }))),
);
process.stdout.write(JSON.stringify(rows));
