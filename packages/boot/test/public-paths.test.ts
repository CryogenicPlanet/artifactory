import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";

const execute = promisify(execFile);
async function store(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-public-paths-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const command = async (fixture: string, ...args: string[]) => {
		const { stdout } = await execute("bun", [join(import.meta.dirname, "fixtures", fixture), ...args]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	const run = async (input: unknown) => {
		// Oversized policies must reach validation without hitting Linux's per-argument size limit.
		const directory = await mkdtemp(join(root, "input-"));
		try {
			const path = join(directory, "input.json");
			await writeFile(path, JSON.stringify(input));
			return await command("events-store.ts", root, "--input-file", path);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};
	const sql = (statement: string) => command("store.ts", join(root, "boot.db"), statement);
	const check = (path: string) => command("public-page-check.ts", root, path);
	const append = async (ordinal: number, type: string, topic: string | null, payload: unknown) => {
		const transaction = `tx-${ordinal}`;
		const reservation = Schema.decodeUnknownSync(
			Schema.Struct({ success: Schema.Struct({ from: Schema.Int, to: Schema.Int }) }),
		)(await run({ op: "reserve", transaction })).success;
		const seq = reservation.from;
		const batch = {
			transaction,
			from: seq,
			to: seq,
			events: [
				{
					seq,
					at: 1,
					type,
					level: "info",
					actor: "rahul",
					instance: "human",
					generation: 1,
					request_id: null,
					topic,
					message_id: null,
					payload,
				},
			],
		};
		return { batch, result: await run({ op: "append", batch }) };
	};
	return { root, run, sql, check, append };
}

it("publishes exact grants with events, rolls both back on failure, and never reapplies an old grant", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.sql(
		"CREATE TRIGGER deny_event BEFORE INSERT ON events WHEN NEW.transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	const original = await app.append(1, "topic.meta", "guide", { path: "guide", meta: { public: true } });
	expect(original.result).toMatchObject({ _tag: "Failure" });
	expect(await app.sql("SELECT * FROM public_paths")).toEqual([]);
	expect(await app.sql("SELECT published_through FROM seq")).toEqual([{ published_through: 0 }]);
	await app.sql("DROP TRIGGER deny_event");
	expect(await app.run({ op: "append", batch: original.batch })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT * FROM public_paths")).toEqual([{ path: "guide" }]);
	expect((await app.append(2, "topic.meta", "guide", { path: "guide", meta: { public: false } })).result).toMatchObject(
		{ _tag: "Success" },
	);
	await app.sql("DELETE FROM events WHERE seq=1");
	expect(await app.run({ op: "append", epoch: "new-owner", batch: original.batch })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT * FROM public_paths")).toEqual([]);
	for (const [index, value] of ["true", 1, null].entries()) {
		expect(
			(await app.append(index + 3, "topic.meta", "guide", { path: "guide", meta: { public: value } })).result,
		).toMatchObject({ _tag: "Success" });
	}
	expect(await app.sql("SELECT * FROM public_paths")).toEqual([]);
	const mismatched = await app.append(6, "topic.meta", "guide", { path: "other", meta: { public: true } });
	expect(mismatched.result).toMatchObject({ _tag: "Failure", failure: { code: "public_path_invalid" } });
	expect(await app.sql("SELECT published_through FROM seq")).toEqual([{ published_through: 10 }]);
}, 15000);

it("moves and revokes public subtrees without matching similarly named directories or replaying moves", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	for (const [index, path] of ["a_b", "a_b/child", "axb/child"].entries())
		expect((await app.append(index + 1, "topic.meta", path, { path, meta: { public: true } })).result).toMatchObject({
			_tag: "Success",
		});
	await app.sql("INSERT INTO topic_moves VALUES('tx-4','a_b','moved','human',NULL,'hash','pages_published',NULL)");
	const move = await app.append(4, "topic.moved", "moved", { from: "a_b", to: "moved" });
	expect(move.result).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT path FROM public_paths ORDER BY path")).toEqual([
		{ path: "axb/child" },
		{ path: "moved" },
		{ path: "moved/child" },
	]);
	await app.append(5, "topic.meta", "a_b/new", { path: "a_b/new", meta: { public: true } });
	await app.run({ op: "append", epoch: "restart", batch: move.batch });
	expect((await app.append(6, "topic.deleted", "moved", { path: "moved", deleted_at: 1 })).result).toMatchObject({
		_tag: "Success",
	});
	expect(await app.sql("SELECT path FROM public_paths ORDER BY path")).toEqual([
		{ path: "a_b/new" },
		{ path: "axb/child" },
	]);
}, 15000);

it("reads published grants without operation/channel permits or pending-publication failures and refuses links", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	for (const directory of ["guide", "guide/private", "guide/assets", "guide/public", "guide-other"])
		await mkdir(join(app.root, "pages", directory), { recursive: true });
	for (const directory of ["guide", "guide/private", "guide/assets", "guide/public", "guide-other"])
		await writeFile(join(app.root, "pages", directory, "file.md"), "content");
	await writeFile(join(app.root, "secret"), "outside");
	await symlink(join(app.root, "secret"), join(app.root, "pages/guide/link.md"));
	await symlink(join(app.root, "pages/guide/public"), join(app.root, "pages/guide/alias"));
	await app.append(1, "topic.meta", "guide", { path: "guide", meta: { public: true } });
	await app.append(2, "topic.meta", "guide/public", { path: "guide/public", meta: { public: true } });
	await app.run({ op: "reserve", transaction: "unrelated-held" });
	for (const path of ["/p/guide/", "/p/guide/file.md", "/p/guide/public/file.md"])
		expect(await app.check(path)).toMatchObject({ _tag: "Success", success: expect.any(String) });
	for (const path of [
		"/p/guide/private/file.md",
		"/p/guide/assets/file.md",
		"/p/guide-other/file.md",
		"/p/guide/link.md",
		"/p/guide/alias/file.md",
		"/p/guide%2ffile.md",
		"/p/guide/a%5cb",
		"/p/guide/.comms-secret",
		"/p/",
	])
		expect(await app.check(path), path).toMatchObject({ _tag: "Success", success: null });
	await app.sql("DELETE FROM public_paths WHERE path='guide'");
	expect(await app.check("/p/guide/file.md")).toMatchObject({ _tag: "Success", success: null });
	expect(await app.check("/p/guide/public/file.md")).toMatchObject({
		_tag: "Success",
		success: "guide%2Fpublic%2Ffile.md",
	});
	await rm(join(app.root, "pages"), { recursive: true });
	await symlink(app.root, join(app.root, "pages"));
	expect(await app.check("/p/secret")).toMatchObject({ _tag: "Success", success: null });
}, 15000);

it("publishes topic metadata and deletion for valid domain names that cannot be served as page paths", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	for (const [index, path] of ["node_modules", "guide/node_modules", "guide/.vite"].entries()) {
		expect(
			(await app.append(index * 2 + 1, "topic.meta", path, { path, meta: { public: true } })).result,
		).toMatchObject({ _tag: "Success" });
		expect((await app.append(index * 2 + 2, "topic.deleted", path, { path, deleted_at: 1 })).result).toMatchObject({
			_tag: "Success",
		});
	}
	expect(await app.sql("SELECT * FROM public_paths")).toEqual([]);
	expect(await app.sql("SELECT published_through,pending_id FROM seq")).toEqual([
		{ published_through: 12, pending_id: null },
	]);
}, 10000);

it("adopts an older boot store with an empty grant projection without guessing from retained events", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.append(1, "topic.meta", "guide", { path: "guide", meta: { public: true } });
	await app.run({ op: "reserve", transaction: "pending" });
	const before = await app.sql("SELECT * FROM seq");
	const event = await app.sql("SELECT event FROM events");
	await app.sql("DROP TABLE public_paths");
	// The combined v14 migration also adds event indexes; remove them when present to model a real v13 store.
	for (const name of ["type", "actor", "instance", "level", "topic"])
		await app.sql(`DROP INDEX IF EXISTS events_${name}_seq`);
	const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
		await app.sql("SELECT name FROM pragma_table_xinfo('events') WHERE name IN ('type','actor','instance','level')"),
	);
	for (const column of columns) await app.sql(`ALTER TABLE events DROP COLUMN ${column.name}`);
	await app.sql("ALTER TABLE generations DROP COLUMN backup_id");
	await app.sql("ALTER TABLE edit_lock DROP COLUMN reset_pin");
	for (const column of ["source_generation", "prior_generation", "source_batch"])
		await app.sql(`ALTER TABLE db_restore_requests DROP COLUMN ${column}`);
	await app.sql("PRAGMA user_version=13");
	expect(await app.run({ op: "init" })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT * FROM public_paths")).toEqual([]);
	expect(await app.sql("SELECT * FROM seq")).toEqual(before);
	expect(await app.sql("SELECT event FROM events")).toEqual(event);
}, 10000);

it("atomically replaces complete activation grants, including empty policy, without replay resurrection", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.append(1, "topic.meta", "old", { path: "old", meta: { public: true } });
	await app.sql(
		"CREATE TRIGGER deny_event BEFORE INSERT ON events WHEN NEW.transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	const replacement = await app.append(2, "pages.public", null, { paths: ["new", "new/child"] });
	expect(replacement.result).toMatchObject({ _tag: "Failure" });
	expect(await app.sql("SELECT path FROM public_paths ORDER BY path")).toEqual([{ path: "old" }]);
	expect(await app.sql("SELECT published_through FROM seq")).toEqual([{ published_through: 2 }]);
	await app.sql("DROP TRIGGER deny_event");
	expect(await app.run({ op: "append", batch: replacement.batch })).toMatchObject({ _tag: "Success" });
	expect(await app.sql("SELECT path FROM public_paths ORDER BY path")).toEqual([
		{ path: "new" },
		{ path: "new/child" },
	]);
	await app.append(3, "pages.public", null, { paths: [] });
	expect(await app.sql("SELECT path FROM public_paths")).toEqual([]);
	await app.sql(`DELETE FROM events WHERE seq=${replacement.batch.from}`);
	expect(await app.run({ op: "append", epoch: "restart", batch: replacement.batch })).toMatchObject({
		_tag: "Success",
	});
	expect(await app.sql("SELECT path FROM public_paths")).toEqual([]);
	const event = replacement.batch.events[0];
	expect(await app.run({ op: "boot", event })).toMatchObject({
		_tag: "Failure",
		failure: { code: "public_path_invalid" },
	});
	expect(await app.sql("SELECT published_through FROM seq")).toEqual([{ published_through: 6 }]);
}, 15000);

it("rejects malformed and oversized activation policies without losing the preceding grants", async (test) => {
	const app = await store(test);
	await app.run({ op: "init" });
	await app.append(1, "topic.meta", "old", { path: "old", meta: { public: true } });
	for (const [index, payload] of [
		{ paths: ["../private"] },
		{ paths: ["node_modules"] },
		{ paths: ["duplicate", "duplicate"] },
		{ paths: Array.from({ length: 4097 }, (_, n) => `p${n}`) },
		{ paths: ["x".repeat(524288)] },
		{ paths: [true] },
	].entries()) {
		const invalid = await app.append(index + 2, "pages.public", null, payload);
		expect(invalid.result).toMatchObject({ _tag: "Failure", failure: { code: "public_path_invalid" } });
		expect(await app.sql("SELECT path FROM public_paths")).toEqual([{ path: "old" }]);
		await app.run({ op: "abort", transaction: invalid.batch.transaction });
	}
}, 15000);
