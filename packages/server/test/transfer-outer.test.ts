import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it("preserves encoded credentials, IPv6 endpoints and TLS through immutable-worker configuration", async () => {
	const result = await execute("bun", [join(import.meta.dirname, "fixtures/transfer-configuration-roundtrip.ts")]);
	expect(result.stdout).toContain("Protected configuration round trip verified");
});
it("the actual transfer entry reports a static error without printing malformed secret input", async () => {
	const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const child = spawn("bun", [join(import.meta.dirname, "../src/store-transfer.ts"), "--config-stdin"], {
			stdio: "pipe",
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
		child.stdin.end("{malformed fixture-secret-never-log");
	});
	expect(result.code).toBe(1);
	expect(result.output).toContain("Store transfer failed;");
	expect(result.output).not.toContain("fixture-secret-never-log");
});
