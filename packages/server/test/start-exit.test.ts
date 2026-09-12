import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([0, 17])("propagates remote worker exit %s only after guardian finalization", async (code) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-start-exit-"));
	try {
		const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
			execFile(
				"bun",
				[join(import.meta.dirname, "fixtures/start-exit.ts"), String(code), directory],
				(error, _stdout, stderr) => {
					const status = error?.code ?? 0;
					if (typeof status !== "number") return reject(error);
					resolve({ code: status, stderr });
				},
			);
		});
		expect(result.code).toBe(code === 0 ? 0 : 1);
		expect(result.stderr).toContain("Guardian closure completed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
