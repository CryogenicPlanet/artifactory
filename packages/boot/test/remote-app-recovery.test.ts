import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
const execute = promisify(execFile);
const run = async (scenario: string) => {
	const { stdout } = await execute("bun", [`${import.meta.dirname}/fixtures/remote-app-recovery.ts`, scenario]);
	return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
};
it("resumes its reserved UUID and follows an atomically journaled restore instead of the environment name", async () => {
	expect(await run("fresh")).toEqual({ same: true, selected: "restored", phase: "ready" });
});
for (const dialect of ["pg", "mysql"])
	it(`${dialect} rolls damaged receipt reads back to a savepoint, commits the fence, then closes before boot finalization`, async () => {
		const result = Schema.decodeUnknownSync(
			Schema.Struct({
				commands: Schema.Array(Schema.String),
				committedWriter: Schema.String,
				result: Schema.Struct({ _tag: Schema.Literal("Failure") }),
			}),
		)(await run(`${dialect}-evidence`));
		expect(result.committedWriter).toBe("new");
		expect(result.commands).toContain("SAVEPOINT effect_sql_1");
		expect(result.commands).toContain("ROLLBACK TO SAVEPOINT effect_sql_1");
		expect(result.commands.slice(-2)).toEqual(["COMMIT", "closed"]);
	});
for (const scenario of [
	"foreign",
	"missing",
	"transferred",
	"pending-missing-writer",
	"denied",
	"boot-transfer",
	"journal-mismatch",
])
	it(`refuses ${scenario} before committing a writer fence`, async () => {
		const result = Schema.decodeUnknownSync(
			Schema.Struct({
				commands: Schema.Array(Schema.String),
				result: Schema.Struct({ _tag: Schema.Literal("Failure") }),
				committedWriter: Schema.optionalKey(Schema.String),
			}),
		)(await run(scenario));
		expect(result.committedWriter).toBeUndefined();
		expect(result.commands.some((command) => command.startsWith("UPDATE kernel_writer"))).toBe(false);
		if (["denied", "boot-transfer", "journal-mismatch"].includes(scenario))
			expect(result.commands.some((command) => command.startsWith("open:"))).toBe(false);
	});
it("initializes only pending adoption and closes its guarded scope after the app commit", async () => {
	const result = Schema.decodeUnknownSync(
		Schema.Struct({
			commands: Schema.Array(Schema.String),
			committedWriter: Schema.String,
			result: Schema.Struct({ _tag: Schema.Literal("Success") }),
		}),
	)(await run("pending"));
	expect(result.committedWriter).toBe("new");
	expect(result.commands.indexOf("initialize")).toBeLessThan(result.commands.indexOf("BEGIN"));
	expect(result.commands.slice(-2)).toEqual(["COMMIT", "closed"]);
});
