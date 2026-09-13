import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

it("matches literal strict descendants for columns and bound paths without changing case or root semantics", async () => {
	const { stdout } = await promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/descendant.ts`]);
	const rows = Schema.decodeSync(
		Schema.fromJsonString(
			Schema.Array(
				Schema.Struct({
					child: Schema.String,
					ancestor: Schema.String,
					matched: Schema.Int,
					bound: Schema.Int,
				}),
			),
		),
	)(stdout);
	expect(rows.map((row) => row.matched)).toEqual([1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
	for (const row of rows) expect(row.bound, `${row.child} under ${row.ancestor}`).toBe(row.matched);
});
