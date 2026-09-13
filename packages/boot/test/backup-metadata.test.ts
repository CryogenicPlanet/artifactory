import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Path } from "effect";
import { backupPath } from "../src/backup-metadata.ts";
import { expect, it } from "vitest";

it("migrates legacy backups without inventing their publication fence or generation", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-backup-metadata-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/backup-metadata.ts"),
		join(directory, "boot.db"),
	]);
	expect(result.stdout).toContain("backup metadata preserved");
});

it("tags v17 artifacts as SQLite while preserving exact provenance across repeated initialization", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-backup-engine-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/backup-metadata.ts"),
		join(directory, "boot.db"),
		"v17",
	]);
	expect(result.stdout).toContain("v17 backup provenance preserved");
});

it("uses the capture engine to name each restorable artifact", async () => {
	const paths = await Effect.runPromise(
		Effect.gen(function* () {
			const path = yield* Path.Path;
			return ["sqlite", "pg", "mysql"].map((engine) =>
				backupPath(path, "/data", "saved", engine === "pg" ? "pg" : engine === "mysql" ? "mysql" : "sqlite"),
			);
		}).pipe(Effect.provide(Path.layer)),
	);
	expect(paths).toEqual(["/data/backups/saved.db", "/data/backups/saved.dump", "/data/backups/saved.sql"]);
});
