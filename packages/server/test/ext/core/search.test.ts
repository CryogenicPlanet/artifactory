import { Effect } from "effect";
import { Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { searchMessages } from "../../../src/ext/core/search.ts";

const constructor = (dialect: "sqlite" | "pg" | "mysql") =>
	Statement.make(
		Effect.die("Compile only"),
		Statement.makeCompiler({
			dialect,
			placeholder: (index) => (dialect === "pg" ? `$${index}` : "?"),
			onIdentifier: (value) => `"${value.replaceAll('"', '""')}"`,
			onRecordUpdate: () => {
				throw new Error("Unused record helper");
			},
			onCustom: () => {
				throw new Error("Unused custom helper");
			},
		}),
		[],
		undefined,
	);

it("keeps caller search operators bound and selects the published image on every engine", async () => {
	for (const name of ["sqlite", "pg", "mysql"] as const) {
		const sql = constructor(name);
		const fragment = await Effect.runPromise(searchMessages(sql, 'alpha OR -beta "blue the moon"', 42));
		const [text, values] = sql`SELECT id FROM visible_messages WHERE ${fragment}`.compile();
		expect(text).not.toContain("alpha");
		expect(text).not.toContain("blue");
		expect(text).toContain("updated_seq<=");
		expect(text).toContain("updated_seq>");
		expect(values.filter((value) => value === 42)).toHaveLength(2);
		if (name === "sqlite") {
			expect(values).toContain('body : ("alpha" AND "OR" AND "-beta" AND "blue the moon")');
			expect(values).toContain('previous_body : ("alpha" AND "OR" AND "-beta" AND "blue the moon")');
		} else if (name === "pg") {
			expect(text).toContain("body_tsv @@");
			expect(text).toContain("previous_body_tsv @@");
			expect(text).toContain("phraseto_tsquery('simple'");
			expect(text).toContain("plainto_tsquery('simple'");
			expect(text).not.toContain("websearch_to_tsquery");
			expect(values).toContain("OR");
			expect(values).toContain("-beta");
		} else {
			expect(text).toContain("MATCH(body) AGAINST");
			expect(text).toContain("MATCH(previous_body) AGAINST");
			expect(values).toContain('+"alpha" +"OR" +"beta" +"blue the moon"');
		}
	}
});

it("rejects invalid search syntax before any engine receives a query", async () => {
	for (const name of ["sqlite", "pg", "mysql"] as const)
		for (const query of [
			"",
			" ",
			'"unterminated',
			'""',
			"***",
			"a\0b",
			"x".repeat(513),
			Array(17).fill("word").join(" "),
		]) {
			const result = await Effect.runPromise(searchMessages(constructor(name), query, 1).pipe(Effect.result));
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure.code).toBe("query_invalid");
		}
});
