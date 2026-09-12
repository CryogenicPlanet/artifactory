import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for([
	"relative",
	"legacy",
	"complete",
	"restore",
	"missing",
	"in_progress",
	"manifest",
	"source",
	"target",
	"uuid",
	"malformed",
	"symlink",
	"no-journal",
	"sql-incomplete",
	"directory",
	"boot",
])("validates immutable activation receipt for %s without rewriting SQL evidence", async (mode) => {
	const { stdout } = await execute("bun", [`${import.meta.dirname}/fixtures/store-transfer-activation.ts`, mode]);
	expect(stdout).toContain('"unchanged":true');
	if (["legacy", "complete", "restore", "relative"].includes(mode)) expect(stdout).toContain('"Success"');
	else expect(stdout).toContain('"code":"store_transfer_incomplete"');
	expect(stdout).not.toContain("localhost");
});
