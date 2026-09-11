import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
for (const mode of ["accepted", "rolled-back", "pending", "page-journal", "page-published"])
	it(`reconciles ${mode} after SIGKILL without executing source undo again`, async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-revert-receipt-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, "pages"));
		await writeFile(join(root, "pages/receipt.md"), "original");
		const script = join(import.meta.dirname, "fixtures/source-revert-receipts.ts");
		await expect(execute("bun", [script, root, mode])).rejects.toMatchObject({ signal: "SIGKILL" });
		const recover = async (state: string) => decode((await execute("bun", [script, root, state])).stdout.trim());
		if (mode === "page-journal") {
			expect(await recover("recover-blocked")).toMatchObject({
				status: 503,
				body: { error: { code: "source_revert_pending" } },
			});
			expect(await readFile(join(root, "pages/receipt.md"), "utf8")).toBe("original");
		}
		const first = await recover("recover");
		if (mode === "accepted") expect(first).toEqual({ status: 200, body: { generation: 7, status: "live" } });
		else if (mode.startsWith("page"))
			expect(first).toEqual({ status: 200, body: { published: true, batch: "page-batch" } });
		else
			expect(first).toMatchObject({
				status: 409,
				body: { error: { code: "source_revert_interrupted", retriable: false } },
			});
		await writeFile(join(root, "pages/receipt.md"), "later edit");
		expect(await recover("recover")).toEqual(first);
		expect(await readFile(join(root, "pages/receipt.md"), "utf8")).toBe("later edit");
	}, 15000);

it("terminalizes cancelled work in the same running service instead of leaving a permanent pending retry", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-revert-cancel-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const script = join(import.meta.dirname, "fixtures/source-revert-receipts.ts");
	expect(decode((await execute("bun", [script, root, "cancel"])).stdout.trim())).toMatchObject({
		status: 409,
		body: { error: { code: "source_revert_interrupted" } },
	});
});
