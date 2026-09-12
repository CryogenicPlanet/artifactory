import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const ledger of ["boot_migrations", "core_migrations"]) {
	for (const mode of ["success", "empty", "failure", "gap", "wrong-name", "mirror", "newer-ledger", "newer-version"]) {
		it(`${ledger}: ${mode} preserves data and validates the complete migration prefix`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "comms-ledger-"));
			const args = [`${import.meta.dirname}/fixtures/migrations.ts`, join(directory, "store.db")];
			try {
				await promisify(execFile)("bun", [...args, "seed", ledger]);
				await promisify(execFile)("bun", [...args, mode, ledger]);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
	it(`${ledger}: SIGKILL rolls back adoption, DDL, receipts and the mirror together before retry`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "comms-ledger-kill-"));
		const args = [`${import.meta.dirname}/fixtures/migrations.ts`, join(directory, "store.db")];
		const run = (mode: string) => promisify(execFile)("bun", [...args, mode, ledger]);
		try {
			await run("seed");
			const before = (await run("snapshot")).stdout;
			const child = spawn("bun", [...args, "crash", ledger], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
				killSignal: "SIGKILL",
			});
			const exited = once(child, "exit");
			try {
				const ready = await Promise.race([
					once(child.stdout, "data").then(([chunk]) => String(chunk)),
					exited.then(() => {
						throw new Error("Migration process exited before crash barrier");
					}),
				]);
				expect(ready).toBe("READY\n");
			} finally {
				child.kill("SIGKILL");
				await exited;
			}
			expect((await run("snapshot")).stdout).toBe(before);
			await run("success");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
