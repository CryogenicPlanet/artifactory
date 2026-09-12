import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedSession } from "./fixtures/session.ts";

it.for(["default", "custom"])(
	"boots a real app with a relative data directory and %s store path",
	async (selection, test) => {
		const root = await mkdtemp(join(tmpdir(), "comms-relative-data-"));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const child = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
			cwd: root,
			env: {
				...process.env,
				DATA_DIR: "data",
				ENTRY: join(import.meta.dirname, "../../server/src/server.ts"),
				...(selection === "custom"
					? { DATABASE_URL: `file:${join(root, "custom.db")}`, BOOT_DATABASE_URL: `file:${join(root, "data/boot.db")}` }
					: {}),
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
			child.kill("SIGTERM");
			const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
			await exited;
			clearTimeout(kill);
		});
		await expect.poll(() => /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]).toBeTruthy();
		const url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
		const { cookie } = await seedSession(join(root, "data"));
		await expect
			.poll(async () => (await (await fetch(`${url}/_boot/status`, { headers: { cookie } })).json()).child.state)
			.toBe("live");
	},
);
