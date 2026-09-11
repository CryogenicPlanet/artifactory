import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { Lock } from "../src/edit-lock.ts";

const execute = promisify(execFile);
const script = join(import.meta.dirname, "fixtures/edit-store.ts");
async function fixture(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-lock-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const db = join(root, "boot.db");
	const call = async (input: object) => {
		const result = await execute("bun", [script, db, Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(input)]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(result.stdout.trim());
	};
	const sql = async (statement: string) => {
		const result = await execute("bun", [join(import.meta.dirname, "fixtures/store.ts"), db, statement]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(result.stdout.trim());
	};
	await call({ op: "init" });
	const acquire = async (options: object = {}) =>
		Schema.decodeUnknownSync(Schema.Struct({ value: Lock }))(await call({ op: "acquire", ...options })).value;
	return { root, db, call, sql, acquire };
}

const owner = (lock: Lock) => ({ id: lock.id, family: lock.holder_family });

describe("durable edit ownership and staging", () => {
	it("serializes independent process contenders with exactly one owner", async (test) => {
		const env = await fixture(test);
		const results = await Promise.all([
			env.call({ op: "acquire", family: "one" }),
			env.call({ op: "acquire", family: "two" }),
		]);
		expect(results.filter((result) => Schema.is(Schema.Struct({ value: Lock }))(result))).toHaveLength(1);
		expect(
			results.filter((result) => Schema.is(Schema.Struct({ error: Schema.Literal("locked") }))(result)),
		).toHaveLength(1);
		expect(await env.sql("SELECT COUNT(*) AS n FROM edit_lock")).toEqual([{ n: 1 }]);
	});

	it("persists create, replace and delete without touching committed source; renewal retains overlay", async (test) => {
		const env = await fixture(test);
		await mkdir(join(env.root, "app"));
		await writeFile(join(env.root, "app/main.ts"), "committed");
		await mkdir(join(env.root, "snapshot"));
		await writeFile(join(env.root, "snapshot/main.ts"), "live");
		const lock = await env.acquire();
		expect(lock.expires - lock.since).toBe(900_000);
		await env.call({ op: "stage", ...owner(lock), path: "app/new.ts", content: "first" });
		await env.call({ op: "stage", ...owner(lock), path: "app/new.ts", content: "replacement" });
		await env.call({ op: "stage", ...owner(lock), path: "app/main.ts", content: null });
		expect(await env.call({ op: "overlay", ...owner(lock) })).toMatchObject({
			value: [{ path: "app/main.ts", content: null }, { path: "app/new.ts" }],
		});
		const renewed = await env.acquire({ note: "still editing" });
		expect(renewed.id).toBe(lock.id);
		expect(
			await env.sql("SELECT path, CAST(content AS TEXT) AS text, length(sha) AS hash FROM staging ORDER BY path"),
		).toEqual([
			{ path: "app/main.ts", text: null, hash: null },
			{ path: "app/new.ts", text: "replacement", hash: 64 },
		]);
		expect(await readFile(join(env.root, "app/main.ts"), "utf8")).toBe("committed");
		expect(await readFile(join(env.root, "snapshot/main.ts"), "utf8")).toBe("live");
		expect(await env.call({ op: "release", ...owner(lock) })).toMatchObject({
			value: null,
			transitions: [{ type: "released", staged: ["app/main.ts", "app/new.ts"] }],
		});
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
	});

	it("commits expired overlay cleanup even when the request is rejected", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		await env.call({ op: "stage", ...owner(lock) });
		await env.sql("UPDATE edit_lock SET expires = 0");
		expect(await env.call({ op: "stage", ...owner(lock) })).toMatchObject({
			error: "lock_required",
			transitions: [{ type: "expired", staged: ["app/main.ts"] }],
		});
		expect(await env.sql("SELECT * FROM edit_lock")).toEqual([]);
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
		const next = await env.acquire();
		await env.sql("UPDATE edit_lock SET expires = 0");
		expect(await env.call({ op: "acquire", ttl: -1 })).toMatchObject({
			error: "invalid_ttl",
			transitions: [{ type: "expired", lock_id: next.id }],
		});
		expect(await env.sql("SELECT * FROM edit_lock")).toEqual([]);
	});

	it("clamps TTL, rejects invalid requests without renewal, and fences stale acquisition IDs", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire({ ttl: 7200 });
		expect(lock.ttl_seconds).toBe(3600);
		for (const ttl of [0, -1, 1.5])
			expect(await env.call({ op: "acquire", ttl })).toMatchObject({ error: "invalid_ttl" });
		expect(await env.call({ op: "stage", ...owner(lock), family: "other" })).toMatchObject({ error: "locked" });
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: { expires: lock.expires } });
		await env.call({ op: "release", ...owner(lock) });
		const next = await env.acquire({ ttl: 60 });
		expect(next.id).not.toBe(lock.id);
		for (const op of ["stage", "release", "pin", "finish", "break"]) {
			expect(await env.call({ op, ...owner(lock) })).toMatchObject({ error: "stale_lock" });
		}
		await env.sql("UPDATE edit_lock SET expires = 9999999999999");
		await env.call({ op: "stage", ...owner(next) });
		const inspected = Schema.decodeUnknownSync(Schema.Struct({ value: Lock }))(await env.call({ op: "inspect" })).value;
		expect(inspected.expires).toBeLessThan(9999999999999);
		expect(inspected.ttl_seconds).toBe(60);
	});

	it("preserves normal lock across restart and clears interrupted pins and orphan staging explicitly", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		await env.call({ op: "stage", ...owner(lock) });
		expect(await env.call({ op: "recover" })).toEqual([]);
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: { id: lock.id } });
		await env.call({ op: "pin", ...owner(lock) });
		// Every call constructs another service/connection; construction must never clear a live pin.
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: { cutover_in_flight: 1 } });
		await env.sql(
			"INSERT INTO staging (lock_id, path, content, sha, at) VALUES ('orphan', 'app/orphan.ts', NULL, NULL, 0)",
		);
		expect(await env.call({ op: "recover" })).toMatchObject([{ type: "interrupted", staged: ["app/main.ts"] }]);
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: null });
	});

	it("pins out expiry and competing operations; failure retains repairs and success consumes its batch", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		await env.call({ op: "stage", ...owner(lock) });
		const pins = await Promise.all([env.call({ op: "pin", ...owner(lock) }), env.call({ op: "pin", ...owner(lock) })]);
		expect(
			pins.filter((result) => Schema.is(Schema.Struct({ error: Schema.Literal("cutover_in_flight") }))(result)),
		).toHaveLength(1);
		await env.sql("UPDATE edit_lock SET expires = 0");
		for (const op of ["stage", "release", "acquire"])
			expect(await env.call({ op, ...owner(lock) })).toMatchObject({ error: "cutover_in_flight" });
		expect(await env.call({ op: "acquire", family: "other" })).toMatchObject({ error: "cutover_in_flight" });
		expect(await env.call({ op: "finish", ...owner(lock), succeeded: false, release: true })).toMatchObject({
			value: { id: lock.id, cutover_in_flight: 0 },
		});
		expect(await env.sql("SELECT COUNT(*) AS n FROM staging")).toEqual([{ n: 1 }]);
		await env.call({ op: "pin", ...owner(lock) });
		await env.call({ op: "finish", ...owner(lock), succeeded: true });
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: { id: lock.id } });
		await env.call({ op: "stage", ...owner(lock) });
		await env.call({ op: "pin", ...owner(lock) });
		expect(await env.call({ op: "finish", ...owner(lock), succeeded: true, release: true })).toMatchObject({
			value: null,
			transitions: [{ type: "released", staged: [] }],
		});
	});

	it("defers targeted break and family revocation until cutover finalization", async (test) => {
		const env = await fixture(test);
		for (const op of ["break", "revoke"]) {
			const lock = await env.acquire();
			await env.call({ op: "stage", ...owner(lock) });
			await env.call({ op: "pin", ...owner(lock) });
			expect(await env.call({ op, ...owner(lock) })).toMatchObject({
				value: { cutover_in_flight: 1 },
				transitions: [{ deferred: true }],
			});
			expect(await env.call({ op: "acquire", family: "other" })).toMatchObject({ error: "cutover_in_flight" });
			expect(await env.call({ op: "finish", ...owner(lock), succeeded: false })).toMatchObject({
				value: null,
				transitions: [{ type: op === "break" ? "broken" : "revoked", staged: ["app/main.ts"] }],
			});
		}
	});

	it("rolls back interrupted SQLite staging and rejects noncanonical paths", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		for (const path of [
			"main.ts",
			"/app/main.ts",
			"app/",
			"app//a",
			"app/../a",
			"app/./a",
			"app/a\\b",
			"app/a\u0000b",
			"app/ext/node_modules/a",
			"app/.vite/x",
			"app/ui/dist/x",
			"app/C:/x",
		]) {
			expect(await env.call({ op: "stage", ...owner(lock), path })).toMatchObject({ error: "invalid_path" });
		}
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: { expires: lock.expires } });
		const child = spawn("bun", [
			script,
			env.db,
			Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ op: "interrupt", ...owner(lock) }),
		]);
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		await new Promise<void>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", () => reject(new Error(`Child exited early: ${output}`)));
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("UNCOMMITTED")) resolve();
			});
		});
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: { expires: lock.expires } });
	});
});
