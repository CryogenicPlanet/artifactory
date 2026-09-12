import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("reports SQL classification without raw messages, statements or credential values", async () => {
	const result = await execute("bun", [join(import.meta.dirname, "fixtures/transfer-diagnostics.ts")]);
	expect(result.stdout.trim()).toBe("Safe SQL diagnostics verified");
	expect(result.stderr).not.toContain("fixture-secret");
	expect(result.stderr).not.toContain("postgres://");
	expect(result.stderr).not.toContain("mysql://");
	const lines = result.stderr
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(lines).toEqual([
		{
			event: "store_transfer_failure",
			stage: "source_inspection",
			code: "sql_error",
			reason: "AuthorizationError",
			sqlstate: "42501",
		},
		{
			event: "store_transfer_failure",
			stage: "source_inspection",
			code: "sql_error",
			reason: "AuthorizationError",
			sqlstate: "42000",
			errno: 1142,
		},
		{ event: "store_transfer_failure", stage: "source_inspection", code: "sql_error", reason: "AuthorizationError" },
		{ event: "store_transfer_failure", stage: "catalog_app", code: "transfer_object_unsupported", object: "unaccent" },
		{
			event: "store_transfer_failure",
			stage: "catalog_app",
			code: "transfer_object_unsupported",
			object: "non_simple_identifier",
		},
		{
			event: "store_transfer_failure",
			stage: "catalog_app",
			code: "transfer_object_unsupported",
			object: "non_simple_identifier",
		},
	]);
});
