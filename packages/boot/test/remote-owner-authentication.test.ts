import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";

it.for(["pg", "mysql"])("only initial %s authentication rejection closes its exact owner", async (engine, test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-owner-authentication-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/remote-owner-authentication.ts"),
		root,
		engine,
	]);
});
