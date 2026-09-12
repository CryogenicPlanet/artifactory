import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
it.for([
	"empty",
	"next",
	"sql-in-progress",
	"legacy",
	"source",
	"pending",
	"ready",
	"in_progress",
	"complete",
	"missing-sql",
	"missing-boot",
	"history",
	"malformed",
	"symlink",
])("checks %s filesystem transfer admission before creating a target SQL store", async (mode) => {
	const { stdout } = await execute("bun", [`${import.meta.dirname}/fixtures/store-transfer-preparation.ts`, mode]);
	if (["legacy", "source", "complete", "empty", "next", "history"].includes(mode))
		expect(stdout).toContain('"Success"');
	else expect(stdout).toContain('"code":"store_transfer_incomplete"');
	if (!["complete", "missing-sql", "history"].includes(mode)) expect(stdout).toContain('"bootCreated":false');
	expect(stdout).not.toContain("localhost");
});

it("real boot refuses a preparing target before opening its absent SQLite file", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-preparing-startup-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "data");
	const id = "11111111-1111-4111-8111-111111111111";
	const folder = join(directory, "transfers", id);
	await mkdir(folder, { recursive: true });
	await writeFile(join(directory, "comms.db"), "opaque target app bytes");
	await writeFile(
		join(folder, "journal.json"),
		JSON.stringify({
			selection: {
				version: 1,
				transfer_id: id,
				data_directory: directory,
				source: { engine: "pg", endpoint: "localhost:5432", boot: "source_boot", app: "source_app" },
				target: {
					engine: "sqlite",
					endpoint: null,
					boot: join(directory, "boot.db"),
					app: join(directory, "comms.db"),
				},
				store_id: "22222222-2222-4222-8222-222222222222",
			},
			initialized_at: 1,
			epoch: "b".repeat(64),
			phase: "preparing",
			sentinel: "pending",
		}),
	);
	const result = await execute("bun", [join(import.meta.dirname, "fixtures/failed-recovery-launcher.ts")], {
		env: { ...process.env, TEST_ROOT: root },
		timeout: 5000,
	}).then(
		() => null,
		(error: unknown) =>
			Schema.decodeUnknownSync(Schema.Struct({ code: Schema.Number, stderr: Schema.String, stdout: Schema.String }))(
				error,
			),
	);
	expect(result?.code).toBe(1);
	expect((result?.stdout ?? "") + (result?.stderr ?? "")).toContain("store_transfer_incomplete");
	await expect(readFile(join(directory, "boot.db"))).rejects.toThrow();
	expect(await readFile(join(directory, "comms.db"), "utf8")).toBe("opaque target app bytes");
});
