import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
it.for(["valid", "invalid", "oversized", "invalid-argv"])(
	"closes inherited config before child creation: %s",
	async (mode, test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-transfer-config-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const filename = join(directory, "config.json");
		const input = {
			version: 1,
			transfer_id: "22222222-2222-4222-8222-222222222222",
			mode: "transfer",
			tls: false,
			source: { boot: "file:/data/boot.db", app: "file:/data/store/comms.db" },
			target: {
				boot: "postgres://boot:private-marker@localhost/boot",
				app: "postgres://app:private-marker@localhost/app",
			},
		};
		await writeFile(
			filename,
			mode === "oversized" ? "x".repeat(65537) : mode === "invalid" ? "{invalid private-marker" : JSON.stringify(input),
			{ mode: 0o600 },
		);
		const file = await open(filename, "r");
		try {
			const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
				const child = spawn(
					"bun",
					[
						join(import.meta.dirname, "fixtures/store-transfer-config.ts"),
						mode === "invalid-argv" ? "--wrong-input" : "--config-stdin",
					],
					{
						stdio: [file.fd, "pipe", "pipe"],
						env: { ...process.env, TRANSFER_CONFIG_EXPECT: mode === "valid" ? "success" : "failure" },
					},
				);
				let output = "";
				if (!child.stdout || !child.stderr) {
					reject(new Error("Missing fixture output pipes"));
					return;
				}
				child.stdout.on("data", (chunk) => {
					output += chunk.toString();
				});
				child.stderr.on("data", (chunk) => {
					output += chunk.toString();
				});
				child.on("error", reject);
				child.on("exit", (code) => resolve({ code, output }));
			});
			expect(result.output).not.toContain("private-marker");
			expect(result.code, result.output).toBe(0);
			expect(result.output).toContain("Configuration consumed and original descriptor closed");
		} finally {
			await file.close();
		}
	},
);
