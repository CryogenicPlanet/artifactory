import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["rollback", "corruption", "concurrent", "natural-retry", "legacy-label"]) {
	test(`human mint: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-mint-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/token-mint-run.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 15000 },
		);
		expect(result.stdout).toContain("mint scenario passed");
	}, 20000);
}
for (const point of ["before", "after"]) {
	test(`human mint: SIGKILL ${point} commit permits one exact retry after restart`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-mint-crash-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const filename = join(directory, "boot.db");
		const runner = join(import.meta.dirname, "fixtures/token-mint-run.ts");
		const child = spawn("bun", [runner, filename, `crash-${point}`], { stdio: ["ignore", "pipe", "pipe"] });
		onTestFinished(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		await expect.poll(() => output, { timeout: 10000 }).toContain(point === "before" ? "UNCOMMITTED" : "COMMITTED");
		expect((await stat(`${filename}.secrets`)).mode & 0o777).toBe(0o600);
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const replay = await promisify(execFile)("bun", [runner, filename, `resume-${point}`], { timeout: 10000 });
		expect(replay.stdout).toContain("mint scenario passed");
	}, 25000);
}
