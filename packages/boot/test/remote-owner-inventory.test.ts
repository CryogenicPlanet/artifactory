import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.for(["clean", "pending", "missing", "missing-inventory", "malformed", "extra", "temporary", "parallel"])(
	"root remote inventory preserves %s restart evidence",
	async (mode, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-owner-inventory-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const run = (mode: string) =>
			promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-owner-inventory.ts"), root, mode]);
		await run(mode);
		if (mode === "clean" || mode === "temporary") await run("recover");
		else await expect(run("recover")).rejects.toThrow();
	},
);

it("SIGKILL after inventory acknowledgment cannot disappear into a fresh startup", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-owner-inventory-crash-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const fixture = join(import.meta.dirname, "fixtures/remote-owner-inventory.ts");
	const child = spawn("bun", [fixture, root, "crash-reserved"], { stdio: ["ignore", "pipe", "pipe"] });
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
	await expect.poll(() => output, { timeout: 5000 }).toContain("INVENTORY_DURABLE");
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	await expect(promisify(execFile)("bun", [fixture, root, "recover"])).rejects.toThrow();
});

it("competing boot roots cannot replace the active root's expected-owner inventory", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-owner-inventory-exclusive-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const fixture = join(import.meta.dirname, "fixtures/remote-owner-inventory.ts");
	const child = spawn("bun", [fixture, root, "claim"], { stdio: ["ignore", "pipe", "pipe"] });
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
	await expect.poll(() => output, { timeout: 5000 }).toContain("INVENTORY_CLAIMED");
	await expect(promisify(execFile)("bun", [fixture, root, "recover"])).rejects.toThrow();
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
	await promisify(execFile)("bun", [fixture, root, "recover"]);
});
