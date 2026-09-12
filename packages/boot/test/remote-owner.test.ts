import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.for(["clean", "pending", "mismatch", "partial", "missing", "bad-inspector", "bad-session"])(
	"durable remote owner %s restart evidence",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-remote-owner-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const run = (mode: string) =>
			promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-owner.ts"), root, mode]);
		await run(mode);
		if (mode === "clean") await run("recover");
		else await expect(run("recover")).rejects.toThrow();
	},
);

it.for(["crash-intent", "crash-register"])("SIGKILL preserves %s as unresolved ownership", async (mode, test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-remote-owner-crash-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const fixture = join(import.meta.dirname, "fixtures/remote-owner.ts");
	const child = spawn("bun", [fixture, root, mode], { stdio: ["ignore", "pipe", "pipe"] });
	test.onTestFinished(() => {
		child.kill("SIGKILL");
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	await expect.poll(() => output, { timeout: 5000 }).toContain("REMOTE_OWNER_DURABLE");
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	await expect(promisify(execFile)("bun", [fixture, root, "recover"])).rejects.toThrow();
});
