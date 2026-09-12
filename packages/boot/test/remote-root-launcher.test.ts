import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it
	.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG || !process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)
	.for(["active", "reserved"])(
	"surviving guardian closes %s boot worker after SIGKILL and reopens",
	{ timeout: 45000 },
	async (mode, test) => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "comms-root-launcher-")));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const launch = (mode: string) => {
			const child = spawn("bun", [join(import.meta.dirname, "fixtures/remote-root-launcher.ts")], {
				env: { ...process.env, DATA_DIR: directory, COMMS_ROOT_TEST_MODE: mode },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += String(chunk);
			});
			// Do not surface configuration-bearing exception details in assertion output.
			child.stderr.resume();
			const exited = once(child, "exit");
			test.onTestFinished(() => {
				child.kill("SIGKILL");
			});
			return { child, exited, output: () => output };
		};
		const first = launch(mode);
		await expect.poll(first.output, { timeout: 10000 }).toMatch(/REMOTE_ROOT_WORKER=\d+/);
		const worker = Number(/REMOTE_ROOT_WORKER=(\d+)/.exec(first.output())?.[1]);
		process.kill(worker, "SIGKILL");
		// A killed worker remains a failed service exit; durable closure must still permit the next launch.
		expect((await first.exited)[0]).toBe(1);
		const second = launch("clean");
		expect((await second.exited)[0]).toBe(0);
		expect(second.output()).toMatch(/REMOTE_ROOT_WORKER=\d+/);
	},
);
