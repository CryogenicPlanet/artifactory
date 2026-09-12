import { Effect, Redacted } from "effect";
import { render } from "@comms/storage/store";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
for (const mode of ["confirmed", "uncertain"])
	it(`private rehearsal keeps reservation evidence until ${mode} outer rollback is resolved`, async (test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-rehearsal-rollback-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const filename = join(directory, "app.db");
		const result = await execute("bun", [join(import.meta.dirname, "fixtures/rehearsal-rollback.ts"), filename, mode], {
			env: {
				...process.env,
				STATE: "rehearsal",
				REHEARSAL_SEQUENCE: "101",
				WRITER_EPOCH: "test-epoch",
				APP_STORE: Redacted.value(await Effect.runPromise(render({ _tag: "file", filename: filename }))),
				APP_DATABASE: filename,
				GENERATION: "7",
			},
			timeout: 10000,
		});
		expect(result.stdout).toContain("REHEARSAL_ROLLBACK_VERIFIED");
	});
