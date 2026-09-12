import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const mode of ["leases", "reject", "pending", "stream", "restart", "prepared", "missing"])
	it.skipIf(
		!process.env.COMMS_REMOTE_TEST_CONFIG ||
			(mode === "prepared" && process.env.COMMS_REMOTE_TEST_ENGINE !== "pg") ||
			(mode === "missing") !== (process.env.COMMS_REMOTE_TEST_ATTRIBUTES === "32"),
	)(
		`real remote session ${mode}`,
		async (test) => {
			const root = await mkdtemp(join(tmpdir(), "comms-remote-sessions-"));
			test.onTestFinished(() => rm(root, { recursive: true, force: true }));
			const journal = join(root, "registered");
			const child = spawn("bun", [join(import.meta.dirname, "fixtures/remote-sessions.ts")], {
				env: { ...process.env, COMMS_REMOTE_TEST_MODE: mode, COMMS_REMOTE_TEST_JOURNAL: journal },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const exited = once(child, "exit");
			test.onTestFinished(async () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exited;
			});
			if (mode === "restart" || mode === "prepared") {
				await expect
					.poll(() => readFile(`${journal}.restart`, "utf8").catch(() => ""), { timeout: 15000 })
					.toBe("ready");
				const container = process.env.COMMS_REMOTE_TEST_CONTAINER;
				if (!container) throw new Error("Missing disposable database container");
				if (mode === "prepared")
					await promisify(execFile)("docker", [
						"exec",
						container,
						"psql",
						"-U",
						"postgres",
						"-c",
						"ALTER SYSTEM SET max_prepared_transactions=10",
					]);
				await promisify(execFile)("docker", ["restart", container], { timeout: 30000 });
				await expect
					.poll(
						async () => {
							const command =
								process.env.COMMS_REMOTE_TEST_ENGINE === "pg"
									? ["pg_isready", "-U", "postgres"]
									: ["mysql", "--defaults-extra-file=/run/secrets/admin.cnf", "-e", "SELECT 1"];
							try {
								await promisify(execFile)("docker", ["exec", container, ...command]);
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 30000 },
					)
					.toBe(true);
				await writeFile(`${journal}.restarted`, "ready");
			}
			await exited;
			expect(child.exitCode, output).toBe(0);
			expect(output).toContain('"passed":true');
			if (mode !== "missing" && mode !== "prepared")
				expect((await readFile(journal, "utf8")).trim().split("\n").length).toBeGreaterThanOrEqual(5);
		},
		60000,
	);
