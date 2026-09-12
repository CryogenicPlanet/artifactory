import { DatabaseSync } from "node:sqlite";
import { Effect, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import * as dialect from "../src/dialect.ts";

const compiler = (name: "sqlite" | "pg" | "mysql") =>
	Statement.makeCompiler({
		dialect: name,
		placeholder: (index) => (name === "pg" ? `$${index}` : "?"),
		onIdentifier: (value) =>
			name === "mysql" ? `\`${value.replaceAll("`", "``")}\`` : `"${value.replaceAll('"', '""')}"`,
		onRecordUpdate: () => {
			throw new Error("Unused record helper");
		},
		onCustom: () => {
			throw new Error("Unused custom helper");
		},
	});
const constructor = (name: "sqlite" | "pg" | "mysql") =>
	Statement.make(Effect.die("Compile only"), compiler(name), [], undefined);

it("compiles literal path and event filters for each supported dialect", () => {
	for (const name of ["sqlite", "pg", "mysql"] as const) {
		const sql = constructor(name);
		const query = sql`SELECT ${dialect.isDescendant(sql, sql("topic"), "a%_*?[")}, ${dialect.replacePrefix(sql, sql("topic"), "a", "b")}, ${dialect.globPrefix(sql, sql("type"), "é😀")}, ${dialect.distinctFrom(sql, sql("instance"), null)}, ${dialect.nullable(sql, null)}, ${dialect.greatest(sql, sql("seq"), 4)} FROM events ${dialect.plannerHint(sql, "event_index")} ${dialect.lockRow(sql)}`;
		const [text, parameters] = query.compile();
		expect(text).not.toContain("a%_*?[");
		expect(parameters).toContain("a%_*?[");
		expect(parameters).toContain("é😀");
		if (name === "sqlite") {
			expect(text).toContain("substr(\"topic\",1,length(?)+1)=?||'/'");
			expect(text).toContain('"instance" IS NOT ?');
			expect(text).toContain('INDEXED BY "event_index"');
			expect(text).not.toContain("FOR UPDATE");
		} else if (name === "pg") {
			expect(text).toContain("starts_with(\"topic\"::text,$1::text||'/')");
			expect(text).toContain("IS DISTINCT FROM");
			expect(text).toContain("::text");
			expect(text).toContain("FOR UPDATE");
			expect(text).not.toContain("INDEXED");
		} else {
			expect(text).toContain("BINARY substr(`topic`,1,char_length(?)+1)=BINARY CONCAT(?,'/')");
			expect(text).toContain("NOT (`instance` <=> ?)");
			expect(text).toContain("FOR UPDATE");
			expect(text).not.toContain("||");
			expect(text).not.toContain("INDEXED");
		}
	}
});

it("binds JSON keys and preserves JSON null separately from the string null", () => {
	for (const name of ["sqlite", "pg", "mysql"] as const) {
		const sql = constructor(name);
		const [text, parameters] =
			sql`SELECT ${dialect.jsonText(sql, sql("previous"), "body")}, ${dialect.jsonInt(sql, sql("previous"), "deleted_at")}, ${dialect.jsonArrayHas(sql, sql("tags"), "x'?")}`.compile();
		expect(text).not.toContain("x'?");
		expect(parameters).toContain("x'?");
		if (name === "pg") expect(text).toContain("jsonb_array_elements_text");
		if (name === "mysql") {
			expect(text).toContain("JSON_TYPE(JSON_EXTRACT");
			expect(text).toContain("='NULL' THEN NULL ELSE JSON_UNQUOTE");
			expect(text).toContain("AS SIGNED");
			expect(text).not.toContain("NULLIF");
		}
	}
});

it("preserves SQLite literal wildcards, Unicode prefixes, nullable JSON and membership", () => {
	const db = new DatabaseSync(":memory:");
	try {
		const sql = constructor("sqlite");
		const query = sql`SELECT ${dialect.isDescendant(sql, "a%_*/child", "a%_*")} AS descendant,
		 ${dialect.isDescendant(sql, "anything/child", "a%_*")} AS unrelated,
		 ${dialect.replacePrefix(sql, "é😀/child", "é😀", "new")} AS replaced,
		 ${dialect.globPrefix(sql, "é😀abc", "é😀")} AS unicode,
		 ${dialect.globPrefix(sql, "ABC", "a")} AS case_sensitive,
		 ${dialect.jsonText(sql, '{"body":"null","deleted_at":null}', "body")} AS body,
		 ${dialect.jsonInt(sql, '{"deleted_at":null}', "deleted_at")} AS deleted_at,
		 ${dialect.jsonInt(sql, '{"edited_at":42}', "edited_at")} AS edited_at,
		 ${dialect.jsonText(sql, "{}", "body")} AS missing,
		 ${dialect.jsonArrayHas(sql, '["a","b"]', "b")} AS member,
		 ${dialect.distinctFrom(sql, null, null)} AS same,
		 ${dialect.distinctFrom(sql, "a", null)} AS different`;
		const [text, values] = query.compile();
		const bindings = values.map((value) => {
			if (value === null || typeof value === "string" || typeof value === "number") return value;
			throw new Error("Unexpected parameter");
		});
		expect(db.prepare(text).get(...bindings)).toEqual({
			descendant: 1,
			unrelated: 0,
			replaced: "new/child",
			unicode: 1,
			case_sensitive: 0,
			body: "null",
			deleted_at: null,
			edited_at: 42,
			missing: null,
			member: 1,
			same: 0,
			different: 1,
		});
	} finally {
		db.close();
	}
});

it("sets Postgres read isolation before queries and skips it under an existing transaction", async () => {
	for (const name of ["sqlite", "pg", "mysql"] as const) {
		const commands: string[] = [];
		const execute = (text: string) =>
			Effect.sync(() => {
				commands.push(text);
				return [];
			});
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.make({
					acquirer: Effect.succeed({
						execute,
						executeRaw: execute,
						executeUnprepared: execute,
						executeValues: execute,
						executeValuesUnprepared: execute,
						executeStream: () => Stream.empty,
					}),
					compiler: compiler(name),
					spanAttributes: [],
				});
				yield* dialect.readTransaction(
					sql,
					sql`SELECT 1`.pipe(Effect.andThen(dialect.readTransaction(sql, sql`SELECT 2`))),
				);
				yield* sql.withTransaction(sql`SELECT 3`.pipe(Effect.andThen(dialect.readTransaction(sql, sql`SELECT 4`))));
			}).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
		);
		expect(commands).toEqual([
			"BEGIN",
			...(name === "pg" ? ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"] : []),
			"SELECT 1",
			"SAVEPOINT effect_sql_1",
			"SELECT 2",
			"COMMIT",
			"BEGIN",
			"SELECT 3",
			"SAVEPOINT effect_sql_1",
			"SELECT 4",
			"COMMIT",
		]);
	}
});
