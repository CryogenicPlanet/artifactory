import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("copies a closed SQLite pair with exact sidecars, verifies receipts and preserves failed artifacts", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-transfer-safety-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/transfer-safety-copy.ts"),
		root,
	]);
	expect(result.stdout).toContain("verified closed SQLite pair safety receipt");
}, 30000);

it("preserves both committed WALs after process death and restores their rows", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-transfer-safety-wal-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const fixture = join(import.meta.dirname, "fixtures/transfer-safety-wal.ts");
	await expect(promisify(execFile)("bun", [fixture, root, "seed"])).rejects.toMatchObject({ signal: "SIGKILL" });
	const result = await promisify(execFile)("bun", [fixture, root]);
	expect(result.stdout).toContain("verified both committed WAL before-images");
}, 30000);
