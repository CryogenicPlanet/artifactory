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
	expect(stderr).toContain(
		JSON.stringify({
			event: "store_transfer_sequence_refused",
			rows: 1,
			singleton_valid: true,
			next_type: "number",
			published_type: "number",
			next_valid: true,
			published_valid: true,
			gap: 1,
			pending_id: false,
			pending_attempt: true,
			pending_from: false,
			pending_to: false,
		}),
	);
	expect(stderr).not.toContain("orphan");
	expect(stderr).not.toContain("secret");
	expect(stderr).not.toContain("12345678-1234-4234-8234-123456789abc");
});
