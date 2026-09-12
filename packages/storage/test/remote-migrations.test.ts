import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_MIGRATION_TEST_CONFIG)(
	"recovers a process killed after DDL and preserves completed migration data",
	async () => {
		const fixture = `${import.meta.dirname}/fixtures/remote-migrations.ts`;
		const run = (mode: string) => promisify(execFile)("bun", [fixture, mode]);
		await run("reset");
		const child = spawn("bun", [fixture, "crash"], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15000,
			killSignal: "SIGKILL",
		});
		const exited = once(child, "exit");
		try {
			const ready = await Promise.race([
				once(child.stdout, "data").then(([chunk]) => String(chunk)),
				exited.then(() => {
					throw new Error("Migration exited before DDL barrier");
				}),
			]);
			expect(ready).toBe("DDL_APPLIED\n");
		} finally {
			child.kill("SIGKILL");
			await exited;
		}
		expect((await run("resume")).stdout).toContain("MIGRATION_VERIFIED");
		expect((await run("resume")).stdout).toContain("MIGRATION_VERIFIED");
		await run("reset");
	},
	30000,
);

it.skipIf(!process.env.COMMS_REMOTE_MIGRATION_TEST_CONFIG)(
	"refuses expression or prefix indexes as full-key postconditions",
	async () => {
		const run = (mode: string) =>
			promisify(execFile)("bun", [`${import.meta.dirname}/fixtures/remote-migrations.ts`, mode]);
		await run("reset");
		try {
			await run("unsafe-index");
		} finally {
			await run("reset");
		}
	},
);
