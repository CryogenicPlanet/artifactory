import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Path } from "effect";
import { backupPath, backupRelativePath } from "../src/backup-metadata.ts";
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

it("accepts catalogued legacy remote names without inferring engines or arbitrary locations", async () => {
	const path = await Effect.runPromise(Path.Path.pipe(Effect.provide(Path.layer)));
	for (const engine of ["pg", "mysql"] as const) {
		for (const root of ["/data", "/canonical"]) {
			expect(
				backupRelativePath(path, "/data", "/canonical", { id: "saved", engine, path: `${root}/backups/saved.db` }),
			).toBe("backups/saved.db");
			const current = backupPath(path, root, "saved", engine);
			expect(backupRelativePath(path, "/data", "/canonical", { id: "saved", engine, path: current })).toBe(
				`backups/${path.basename(current)}`,
			);
		}
		for (const filename of [
			"/elsewhere/backups/saved.db",
			"/data/backups/../saved.db",
			"/data/backups/other.db",
			"/data/backups/saved.zip",
		]) {
			expect(backupRelativePath(path, "/data", "/canonical", { id: "saved", engine, path: filename })).toBeNull();
		}
	}
	expect(
		backupRelativePath(path, "/data", "/canonical", {
			id: "saved",
			engine: "sqlite",
			path: "/data/backups/saved.dump",
		}),
	).toBeNull();
	expect(
		backupRelativePath(path, "/data", "/canonical", { id: "../saved", engine: "pg", path: "/data/saved.db" }),
	).toBeNull();
});
