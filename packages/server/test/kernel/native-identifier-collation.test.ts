import { spawn } from "node:child_process";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_COLLATION_CONFIG)(
	"native identifier columns preserve case and refuse accent-insensitive reopen",
	async () => {
		const child = spawn("bun", [`${import.meta.dirname}/../fixtures/native-identifier-collation.ts`], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 20000,
			killSignal: "SIGKILL",
		});
		let phases = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			phases += chunk;
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(code, `Identifier collation acceptance fixture failed after ${phases}`).toBe(0);
	},
	25000,
);
