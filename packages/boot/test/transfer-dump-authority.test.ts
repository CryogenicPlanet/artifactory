import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.for(["localhost", "127.0.0.1", "[::1]"])(
	"requires exact offline dump authority at %s",
	{ timeout: 30000 },
	async (host, test) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "comms-dump-authority-")));
		test.onTestFinished(() => rm(root, { recursive: true, force: true }));
		const result = await promisify(execFile)("bun", [
			join(import.meta.dirname, "fixtures/transfer-dump-authority.ts"),
			root,
			host,
		]);
		expect(result.stdout).toContain("verified exact offline dump authority");
	},
);
