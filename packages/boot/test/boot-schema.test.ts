import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";

async function fixture(test: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "comms-boot-ledger-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	return async (mode: string) =>
		(
			await promisify(execFile)("bun", [
				join(import.meta.dirname, "fixtures/boot-schema.ts"),
				join(directory, "boot.db"),
				mode,
			])
		).stdout;
}

it("persists all nineteen named boot receipts and preserves them across process restart", async (test) => {
	const run = await fixture(test);
	const fresh = await run("fresh");
	expect(JSON.parse(await run("fresh"))).toEqual(JSON.parse(fresh));
});

it.for(["legacy", "legacy-ledger"])(
	"upgrades an initialized v18 %s store without replaying DDL or changing credentials and settings",
	async (mode, test) => {
		const run = await fixture(test);
		expect(await run(mode)).toContain("legacy fixture persisted");
		const adopted = await run("adopt");
		expect(JSON.parse(await run("adopt"))).toEqual(JSON.parse(adopted));
	},
);

it.for(["empty", "gap", "name", "mirror", "newer-ledger", "newer-version"])(
	"refuses boot %s corruption before schema or mirror changes",
	async (mode, test) => {
		const run = await fixture(test);
		expect(await run(mode)).toContain("refused without schema, receipt, mirror or data changes");
	},
);

it("concurrent legacy initializers either adopt or fail cleanly, and retry preserves one receipt prefix", async (test) => {
	const run = await fixture(test);
	await run("legacy");
	const attempts = await Promise.allSettled([run("adopt"), run("adopt")]);
	for (const attempt of attempts) {
		if (attempt.status === "rejected") {
			const error: unknown = attempt.reason;
			expect(String(error)).toMatch(/SQLITE_BUSY|database is locked|database table is locked/i);
		}
	}
	const retried = JSON.parse(await run("adopt"));
	for (const attempt of attempts)
		if (attempt.status === "fulfilled") expect(JSON.parse(attempt.value)).toEqual(retried);
	expect(JSON.parse(await run("adopt"))).toEqual(retried);
});
