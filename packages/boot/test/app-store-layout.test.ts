import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it, type TestContext } from "vitest";

async function directory(test: TestContext, initialized = true) {
	const root = await mkdtemp(join(tmpdir(), "comms-store-layout-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "store"));
	const boot = new DatabaseSync(join(root, "boot.db"));
	try {
		boot.exec(
			"CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE identities(name TEXT); INSERT INTO identities VALUES('retained')",
		);
		if (initialized) boot.exec("INSERT INTO settings VALUES('app_store_initialized','1')");
	} finally {
		boot.close();
	}
	await mkdir(join(root, "pages"));
	await writeFile(join(root, "pages/note.md"), "retained page");
	return root;
}
function sql(filename: string, statement: string) {
	const db = new DatabaseSync(filename);
	try {
		return db.prepare(statement).all();
	} finally {
		db.close();
	}
}
function seed(root: string) {
	const db = new DatabaseSync(join(root, "comms.db"));
	try {
		db.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('retained message')");
	} finally {
		db.close();
	}
}
async function run(root: string, operation = "migrate") {
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/app-store-layout.ts"),
		root,
		operation,
	]);
	const value: unknown = JSON.parse(result.stdout);
	return value;
}

describe("separate app store layout", () => {
	it("preserves committed WAL after actual process death and leaves pages and identities intact", async (test) => {
		const root = await directory(test);
		const child = spawn("bun", [join(import.meta.dirname, "fixtures/app-store-layout.ts"), root, "wal"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = once(child, "exit");
		test.onTestFinished(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		await expect.poll(() => output, { timeout: 5000 }).toContain("ready");
		expect((await stat(join(root, "comms.db-wal"))).size).toBeGreaterThan(0);
		child.kill("SIGKILL");
		await exited;
		expect(await run(root)).toMatchObject({ result: "Success" });
		expect(sql(join(root, "store/comms.db"), "SELECT value FROM records")).toEqual([{ value: "committed WAL" }]);
		expect((await stat(join(root, "store/comms.db"))).mode & 0o777).toBe(0o660);
		expect(sql(join(root, "boot.db"), "SELECT name FROM identities")).toEqual([{ name: "retained" }]);
		expect(await readFile(join(root, "pages/note.md"), "utf8")).toBe("retained page");
		expect(await run(root)).toMatchObject({ result: "Success" });
	});
	it.for(["before-rename", "after-rename"])(
		"resumes %s without replacing the retained store",
		async (operation, test) => {
			const root = await directory(test);
			seed(root);
			await expect(run(root, operation)).rejects.toMatchObject({ signal: "SIGKILL" });
			expect(sql(join(root, "boot.db"), "SELECT value FROM settings WHERE key='app_store_layout'")).toEqual([
				{ value: "moving" },
			]);
			expect(await run(root)).toMatchObject({ result: "Success" });
			expect(sql(join(root, "store/comms.db"), "SELECT value FROM records")).toEqual([{ value: "retained message" }]);
		},
	);
	it("allows only an uninitialized absent database and never creates it", async (test) => {
		const root = await directory(test, false);
		expect(await run(root)).toMatchObject({ result: "Success" });
		await expect(stat(join(root, "store/comms.db"))).rejects.toMatchObject({ code: "ENOENT" });
		const missing = await directory(test);
		expect(await run(missing)).toMatchObject({
			result: "Failure",
			error: expect.stringContaining("app_store_missing"),
		});
	});
	it("refuses two stores and preserves both byte-for-byte", async (test) => {
		const root = await directory(test);
		seed(root);
		const before = await readFile(join(root, "comms.db"));
		await writeFile(join(root, "store/comms.db"), "unrelated");
		expect(await run(root)).toMatchObject({ result: "Failure" });
		expect(await readFile(join(root, "comms.db"))).toEqual(before);
		expect(await readFile(join(root, "store/comms.db"), "utf8")).toBe("unrelated");
	});
	it("refuses a busy WAL checkpoint without moving the database", async (test) => {
		const root = await directory(test);
		seed(root);
		const writer = new DatabaseSync(join(root, "comms.db"));
		const reader = new DatabaseSync(join(root, "comms.db"));
		try {
			writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
			reader.exec("BEGIN");
			reader.prepare("SELECT * FROM records").all();
			writer.exec("INSERT INTO records VALUES('committed during read')");
			expect(await run(root)).toMatchObject({
				result: "Failure",
				error: expect.stringContaining("app_checkpoint_busy"),
			});
			await expect(stat(join(root, "store/comms.db"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(writer.prepare("SELECT count(*) AS count FROM records").get()).toEqual({ count: 2 });
		} finally {
			reader.close();
			writer.close();
		}
		expect(await run(root)).toMatchObject({ result: "Success" });
		expect(sql(join(root, "store/comms.db"), "SELECT count(*) AS count FROM records")).toEqual([{ count: 2 }]);
	});
	it.for(["comms.db", "comms.db-wal", "store/comms.db"])("refuses a dangling link at %s", async (name, test) => {
		const root = await directory(test, false);
		await symlink(join(root, "absent"), join(root, name));
		expect(await run(root)).toMatchObject({ result: "Failure" });
	});
	it("refuses orphan WAL and an unjournaled destination", async (test) => {
		const orphan = await directory(test, false);
		await writeFile(join(orphan, "comms.db-wal"), "retain");
		expect(await run(orphan)).toMatchObject({ result: "Failure" });
		expect(await readFile(join(orphan, "comms.db-wal"), "utf8")).toBe("retain");
		const target = await directory(test);
		await writeFile(join(target, "store/comms.db"), "retain");
		expect(await run(target)).toMatchObject({ result: "Failure" });
	});
});
