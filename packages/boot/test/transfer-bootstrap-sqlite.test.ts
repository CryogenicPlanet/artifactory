import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("commits a target sentinel before boot DDL and adopts it only under transfer guards", async () => {
	const directory = await realpath(await mkdtemp("/tmp/comms-bootstrap-sqlite-"));
	try {
		const { stdout } = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/transfer-bootstrap-sqlite.ts"), directory],
			{ timeout: 30000 },
		);
		expect(stdout).toContain("SENTINEL_BOOTSTRAP_VERIFIED");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 35000);
