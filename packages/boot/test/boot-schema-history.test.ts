import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";
const execute = promisify(execFile);
async function fixture(test: TestContext, version: number) {
	const directory = await mkdtemp(join(tmpdir(), "comms-historical-boot-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const filename = join(directory, "boot.db");
	const run = async (mode: string) =>
		(
			await execute("bun", [
				join(import.meta.dirname, "fixtures/boot-schema-history.ts"),
				filename,
				mode,
				String(version),
			])
		).stdout;
	const bytes = async () => ({
		size: (await stat(filename)).size,
		sha256: createHash("sha256")
			.update(await readFile(filename))
			.digest("hex"),
	});
	return { run, bytes };
}
it.for([16, 18])(
	"adopts the independently generated historical v%i catalog and preserves closed-store bytes on restart",
	async (version, test) => {
		const f = await fixture(test, version);
		expect(await f.run("seed")).toContain("without executing the current initializer");
		expect(await f.run("adopt")).toContain("Historical adoption and retained data verified");
		const before = await f.bytes();
		expect(await f.run("adopt")).toContain("Historical adoption and retained data verified");
		expect(await f.bytes()).toEqual(before);
	},
);
it.for(["missing-column", "missing-table"])(
	"rolls historical adoption back when %s prevents boot's required shape",
	async (mode, test) => {
		const f = await fixture(test, 18);
		await f.run(mode);
		expect(await f.run("refuse")).toContain("without receipts, catalog, version or retained data changes");
	},
);
