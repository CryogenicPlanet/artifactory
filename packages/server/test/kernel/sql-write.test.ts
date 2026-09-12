import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/sql-write-faults.ts");
it.for(["reserve-lost", "append-before", "append-lost", "sql-failure"])(
	"SQL writes retain publication, retry and epoch guarantees after %s",
	{ timeout: 20000 },
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-sql-write-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await execute("bun", [fixture, root, mode], { timeout: 15000 });
		expect(result.stdout).toContain("SQL_WRITE_RECOVERED");
	},
);
it("recovers a committed SQL write after SIGKILL with one event and its original retry outcome", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-sql-restart-"));
	const child = spawn("bun", [fixture, root, "crash"], { stdio: ["ignore", "pipe", "pipe"] });
	test.onTestFinished(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	});
	let output = "";
	let errors = "";
	await new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("SQL_COMMITTED_UNPUBLISHED")) resolve();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`Fixture exited before SQL commit: ${errors}`)));
	});
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	const result = await execute("bun", [fixture, root, "recover"], { timeout: 15000 });
	expect(result.stdout).toContain("SQL_WRITE_RECOVERED");
}, 20000);
