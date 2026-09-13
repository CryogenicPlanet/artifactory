import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG)(
	"real remote SQL leases, transactions, streams and integer codecs",
	async () => {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[join(import.meta.dirname, "fixtures/remote-sessions.ts")],
			{
				env: { ...process.env, COMMS_REMOTE_TEST_MODE: "leases" },
				timeout: 30000,
				killSignal: "SIGKILL",
			},
		);
		expect(stdout).toBe(JSON.stringify({ mode: "leases", passed: true }));
	},
	35000,
);
