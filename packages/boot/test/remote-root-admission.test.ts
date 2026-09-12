import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";

it.for(["clean", "admitted", "missing-proof", "changed-proof"])(
	"requires durable never-opened evidence: %s",
	async (mode, test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-root-admission-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/remote-root-admission.ts"), directory, mode]);
	},
);
