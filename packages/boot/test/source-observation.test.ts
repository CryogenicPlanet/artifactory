import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
async function fixture(test: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-observed-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "app"));
	await writeFile(join(root, "app/main.ts"), "original");
	await chmod(join(root, "app/main.ts"), 0o751);
	const call = async (operation: string, batch?: string) =>
		decode(
			(
				await execute("bun", [
					join(import.meta.dirname, "fixtures/source-observation.ts"),
					root,
					operation,
					...(batch ? [batch] : []),
				])
			).stdout.trim(),
		);
	const sql = async (statement: string) =>
		decode(
			(
				await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), join(root, "boot.db"), statement])
			).stdout.trim(),
		);
	return { root, call, sql };
}

it("refuses an unproven baseline and records fresh baseline bytes and exact modes", async (test) => {
	const env = await fixture(test);
	expect(await env.call("observe")).toMatchObject({ _tag: "Failure", failure: { code: "watcher_baseline_missing" } });
	expect(await env.call("baseline")).toMatchObject({ _tag: "Success" });
	expect(await env.call("observe")).toMatchObject({ _tag: "Success", value: { changes: [] } });
	expect(await env.call("undo")).toMatchObject({ _tag: "Success", value: { captured: "original" } });
	expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("original");
	await writeFile(join(env.root, "app/main.ts"), "external");
	expect(await env.call("publish")).toMatchObject({
		_tag: "Success",
		value: { captured: "external", published: { _tag: "Success" } },
	});
	expect(
		await env.sql(
			"SELECT CAST(previous_content AS TEXT) AS content,previous_mode,agent FROM versions WHERE agent='watcher'",
		),
	).toEqual([{ content: "original", previous_mode: 0o751, agent: "watcher" }]);
	expect(await env.call("observe")).toMatchObject({ _tag: "Success", value: { changes: [] } });
});

it("materializes the captured tree and rejects new paths arriving before publication without rewriting external files", async (test) => {
	const env = await fixture(test);
	await mkdir(join(env.root, "app/empty"));
	await env.call("baseline");
	await writeFile(join(env.root, "app/main.ts"), "external");
	expect(await env.call("race")).toMatchObject({
		_tag: "Success",
		value: {
			captured: "external",
			laterIncluded: false,
			emptyIncluded: true,
			published: { _tag: "Failure", failure: { code: "external_conflict" } },
		},
	});
	expect(await readFile(join(env.root, "app/later.txt"), "utf8")).toBe("later edit");
	expect(await env.sql("SELECT * FROM source_changes")).toEqual([]);
	expect(await env.sql("SELECT id FROM versions WHERE agent='watcher'")).toEqual([]);
	expect(await env.sql("SELECT * FROM edit_lock")).toEqual([]);
});

it("versions file-directory replacements without touching the externally created structure", async (test) => {
	const env = await fixture(test);
	await writeFile(join(env.root, "app/shape"), "old file");
	await env.call("baseline");
	await rm(join(env.root, "app/shape"));
	await mkdir(join(env.root, "app/shape"));
	await writeFile(join(env.root, "app/shape/child"), "new child");
	expect(await env.call("publish")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Success" } } });
	expect(
		await env.sql(
			"SELECT path,CAST(content AS TEXT) AS content FROM versions WHERE agent='watcher' AND path LIKE 'app/shape%' ORDER BY id",
		),
	).toEqual([
		{ path: "app/shape", content: null },
		{ path: "app/shape/child", content: "new child" },
	]);
	expect(await env.call("undo_batch")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Success" } } });
	expect(await readFile(join(env.root, "app/shape"), "utf8")).toBe("old file");
	await rm(join(env.root, "app/shape"));
	await mkdir(join(env.root, "app/shape"));
	await writeFile(join(env.root, "app/shape/child"), "second child");
	await env.call("publish");
	await rm(join(env.root, "app/shape"), { recursive: true });
	await writeFile(join(env.root, "app/shape"), "replacement file");
	expect(await env.call("publish")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Success" } } });
	expect(await readFile(join(env.root, "app/shape"), "utf8")).toBe("replacement file");
	expect(await env.call("observe")).toMatchObject({ _tag: "Success", value: { changes: [] } });
});

it("rolls back failed history atomically and retains unavailable large before-images as unavailable", async (test) => {
	const env = await fixture(test);
	await writeFile(join(env.root, "app/main.ts"), "x".repeat(1024 * 1024 + 1));
	await env.call("baseline");
	await writeFile(join(env.root, "app/main.ts"), "small");
	await env.sql(
		"CREATE TRIGGER reject_history BEFORE INSERT ON versions WHEN NEW.agent='watcher' BEGIN SELECT RAISE(ABORT,'fixture'); END",
	);
	expect(await env.call("publish")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Failure" } } });
	expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("small");
	expect(await env.sql("SELECT id FROM source_batches WHERE agent='watcher'")).toEqual([]);
	await env.sql("DROP TRIGGER reject_history");
	expect(await env.call("publish")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Success" } } });
	expect(
		await env.sql(
			"SELECT previous_content,versioned,reason,previous_sha IS NOT NULL AS retained_hash FROM versions WHERE agent='watcher'",
		),
	).toEqual([{ previous_content: null, versioned: 0, reason: "size_limit", retained_hash: 1 }]);
});

it("versions directory-only edits and restores their absence through batch undo", async (test) => {
	const env = await fixture(test);
	await env.call("baseline");
	await mkdir(join(env.root, "app/new-empty"));
	expect(await env.call("publish")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Success" } } });
	expect(
		await env.sql("SELECT directory,previous_directory FROM versions WHERE path='app/new-empty' AND agent='watcher'"),
	).toEqual([{ directory: 1, previous_directory: 0 }]);
	expect(await env.call("undo_batch")).toMatchObject({ _tag: "Success", value: { published: { _tag: "Success" } } });
	await expect(readFile(join(env.root, "app/new-empty"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(await env.call("observe")).toMatchObject({ _tag: "Success", value: { changes: [] } });
});

it("undoes a structural watcher batch while preserving later unrelated edits and new files", async (test) => {
	const env = await fixture(test);
	await env.call("baseline");
	await mkdir(join(env.root, "app/new-empty"));
	await env.call("publish");
	const batch = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(
		await env.sql("SELECT id FROM source_batches WHERE agent='watcher'"),
	)[0]?.id;
	if (!batch) throw new Error("Missing watcher batch");
	await writeFile(join(env.root, "app/main.ts"), "later unrelated edit");
	await writeFile(join(env.root, "app/later.txt"), "later unrelated file");
	expect(await env.call("undo_batch", batch)).toMatchObject({
		_tag: "Success",
		value: { captured: "later unrelated edit", published: { _tag: "Success" } },
	});
	expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("later unrelated edit");
	expect(await readFile(join(env.root, "app/later.txt"), "utf8")).toBe("later unrelated file");
	await expect(readFile(join(env.root, "app/new-empty"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("path undo skips unchanged structural checkpoint rows", async (test) => {
	const env = await fixture(test);
	await env.call("baseline");
	await writeFile(join(env.root, "app/main.ts"), "changed");
	await env.call("publish");
	await mkdir(join(env.root, "app/new-empty"));
	await env.call("publish");
	expect(await env.call("undo")).toMatchObject({
		_tag: "Success",
		value: { captured: "original", published: { _tag: "Success" } },
	});
	expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("original");
});
