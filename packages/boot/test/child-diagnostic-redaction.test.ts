import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

for (const mode of ["running", "failure"] as const) {
	it(`redacts split child diagnostics before ${mode === "running" ? "retaining them" : "returning startup failure"}`, async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-stderr-redaction-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const { stdout, stderr } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/child-diagnostic-redaction.ts"), root, mode],
			{ timeout: 10000 },
		);
		expect(stderr).toBe("");
		const result = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					stderr: Schema.String,
					code: Schema.optionalKey(Schema.String),
					observed: Schema.optionalKey(Schema.Array(Schema.String)),
				}),
			),
		)(stdout.trim());
		if (mode === "failure") expect(result.code).toBe("child_exited");
		const password = "split/private@password?fixture";
		for (const text of [result.stderr, ...(result.observed ?? [])]) {
			expect(text).not.toContain(password);
			expect(text).not.toContain(encodeURIComponent(password));
			expect(text).not.toContain("oversized-tail-canary");
		}
		expect(result.stderr).toContain("SQLSTATE=08006");
		expect(result.stderr).toContain("request=fixture");
		expect(result.stderr).toContain("[diagnostic line too long]");
		expect(result.stderr).toContain("EOF diagnostic [redacted]");
	}, 15000);
}
