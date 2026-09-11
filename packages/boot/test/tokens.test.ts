import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["rotation", "reuse", "corruption", "rollback", "revoke", "migration", "persist"]) {
	test(`tokens: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-tokens-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const run = (name: string) =>
			promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/tokens-run.ts"), join(directory, "boot.db"), name],
				{ timeout: 20000 },
			);
		expect((await run(scenario)).stdout).toContain("token scenario passed");
		if (scenario === "persist") expect((await run("resume")).stdout).toContain("token scenario passed");
	}, 25000);
}
for (const scenario of ["crash-before", "crash-after"]) {
	test(`tokens: SIGKILL ${scenario} is atomic and restart-safe`, async (test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-tokens-crash-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const filename = join(directory, "boot.db");
		const child = spawn("bun", [join(import.meta.dirname, "fixtures/tokens-run.ts"), filename, scenario], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		test.onTestFinished(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		await expect
			.poll(() => output, { timeout: 10000 })
			.toContain(scenario === "crash-before" ? "UNCOMMITTED" : "COMMITTED");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		if (scenario === "crash-after")
			expect(
				(
					await promisify(execFile)("bun", [
						join(import.meta.dirname, "fixtures/tokens-run.ts"),
						filename,
						"crash-resume",
					])
				).stdout,
			).toContain("token scenario passed");
		else {
			const query = async (statement: string) =>
				JSON.parse(
					(await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/store.ts"), filename, statement]))
						.stdout,
				);
			expect(await query("SELECT kind,rotated_to,last_used_at FROM tokens ORDER BY kind")).toEqual([
				{ kind: "access", rotated_to: null, last_used_at: null },
				{ kind: "refresh", rotated_to: null, last_used_at: null },
			]);
			expect(await query("SELECT * FROM refresh_receipts")).toEqual([]);
			expect(await query("SELECT * FROM refresh_idempotency")).toEqual([]);
			expect(await query("SELECT * FROM events WHERE json_extract(event,'$.type')='token.refreshed'")).toEqual([]);
		}
	}, 20000);
}
