import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for(["fresh", "complete", "incomplete", "unknown", "retired", "app-retired"])(
	"checks %s transfer state without changing schema or reserving identity",
	async (mode) => {
		const { stdout } = await execute("bun", [`${import.meta.dirname}/fixtures/store-transfer-state.ts`, mode]);
		expect(stdout).toContain('"unchanged":true');
		if (mode === "incomplete" || mode === "unknown") expect(stdout).toContain("store_transfer_incomplete");
		else if (mode.endsWith("retired")) expect(stdout).toContain("store_transferred");
		else expect(stdout).toContain('"Success"');
		expect(stdout).not.toContain("private target");
	},
);

it.for(["transfer_state", "transferred_to"])(
	"rejects %s before real startup changes either store",
	async (key, test) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "comms-transfer-refusal-")));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, "data"));
		const filename = join(root, "data/boot.db");
		for (const statement of [
			"CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
			`INSERT INTO settings VALUES('${key}','private target')`,
			"PRAGMA user_version=1",
		])
			await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), filename, statement]);
		await writeFile(join(root, "data/comms.db"), "opaque app bytes");
		const before = await readFile(filename);
		const child = spawn("bun", [join(import.meta.dirname, "fixtures/failed-recovery-launcher.ts")], {
			env: { ...process.env, TEST_ROOT: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		test.onTestFinished(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const closed = once(child, "exit");
			child.kill("SIGTERM");
			await Promise.race([closed, delay(6000, undefined, { ref: false })]);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		let url = "";
		await expect
			.poll(
				() => {
					url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
					return url;
				},
				{ timeout: 5000 },
			)
			.not.toBe("");
		await expect
			.poll(async () => (await fetch(`${url}/_boot/status`)).status)
			.toBe(409)
			.catch(() => {
				throw new Error(output);
			});
		const body = await (await fetch(`${url}/_boot/status`)).text();
		expect(body).toContain(key === "transfer_state" ? "store_transfer_incomplete" : "store_transferred");
		expect(body).not.toContain("private target");
		expect(body).not.toContain(root);
		expect(await readFile(filename)).toEqual(before);
		expect(await readFile(join(root, "data/comms.db"), "utf8")).toBe("opaque app bytes");
	},
);
