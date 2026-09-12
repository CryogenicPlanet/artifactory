import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("selects durable source identity and refuses unfinished publication, ownership and recovery evidence without mutation", async () => {
	const { stdout, stderr } = await promisify(execFile)("bun", [
		`${import.meta.dirname}/../fixtures/transfer/source-preflight.ts`,
	]);
	expect(stdout.trim()).toBe('{"passed":true}');
	for (const reason of [
		"child_closure_pending",
		"outbox_pending",
		"remote_resource_not_closed",
		"app_schema_incomplete",
	]) {
		expect(stderr).toContain(JSON.stringify({ event: "store_transfer_source_refused", reason }));
	}
	expect(stderr).not.toContain("secret");
	expect(stderr).not.toContain("12345678-1234-4234-8234-123456789abc");
});
