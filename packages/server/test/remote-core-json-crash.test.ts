import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_REMOTE_CORE_JSON_CRASH_CONFIG)(
	"reopens after SIGKILL between native JSON ALTER and its migration receipt",
	async () => {
		const fixture = `${import.meta.dirname}/fixtures/remote-core-json-crash.ts`;
		const child = spawn("bun", [fixture, "crash"], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15000,
			killSignal: "SIGKILL",
		});
		const exited = once(child, "exit");
		try {
			const ready = await Promise.race([
				(async () => {
					let output = "";
					for await (const chunk of child.stdout) {
						if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected barrier chunk");
						output += chunk.toString("utf8");
						if (output.length > 128) throw new Error("Unexpected barrier output");
						if (output.endsWith("\n")) return output;
					}
					throw new Error("Missing JSON DDL barrier");
				})(),
				exited.then(() => {
					throw new Error("Core migration exited before JSON DDL barrier");
				}),
			]);
			expect(ready).toBe("JSON_DDL_APPLIED\n");
		} finally {
			child.kill("SIGKILL");
			await exited;
		}
		expect(child.signalCode).toBe("SIGKILL");
		for (const mode of ["recover", "verify"]) {
			const result = await promisify(execFile)("bun", [fixture, mode], { timeout: 15000 });
			expect(result.stdout).toBe("JSON_CRASH_RECOVERY_VERIFIED\n");
		}
	},
	30000,
);
