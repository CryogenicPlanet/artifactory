import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

for (const selection of ["descriptor", "legacy", "mismatch"] as const)
	it(`starts with ${selection} store configuration only when its selection is valid`, async (test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-descriptor-child-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const filename = join(root, "app.db");
		const child = spawn("bun", [join(import.meta.dirname, "../src/server.ts")], {
			env: {
				PATH: process.env.PATH,
				PORT: "0",
				STATE: "candidate",
				WRITER_EPOCH: "descriptor-test",
				GENERATION: "1",
				BOOT_URL: "http://127.0.0.1:1",
				BOOT_SECRET: "descriptor-test-secret",
				PAGES_DIRECTORY: root,
				...(selection === "legacy" ? {} : { APP_STORE: `file:${filename}` }),
				...(selection === "descriptor"
					? {}
					: { APP_DATABASE: selection === "legacy" ? filename : join(root, "other.db") }),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		test.onTestFinished(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		});
		if (selection === "mismatch") {
			await expect.poll(() => child.exitCode).not.toBeNull();
			expect(child.exitCode).not.toBe(0);
			expect(output).toContain("APP_STORE: store_descriptor_mismatch");
			expect(output).not.toContain("COMMS_CHILD_PORT=");
			expect(await readdir(root)).toEqual([]);
		} else {
			await expect.poll(() => /COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1]).toBeTruthy();
			const port = /COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1];
			const response = await fetch(`http://127.0.0.1:${port}/_kernel/control`, {
				method: "POST",
				headers: { "x-boot-secret": "descriptor-test-secret", "content-type": "application/json" },
				body: JSON.stringify({ action: "frozen" }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ state: "frozen", mutations: 0, requests: 0 });
		}
	});
