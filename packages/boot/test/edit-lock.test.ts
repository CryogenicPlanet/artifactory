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
	it.for(["cutover", "restore", "source", "ownerless-source", "ownerless-uppercase-source"])(
		"refuses repair expiry under contradictory %s ownership",
		async (kind, test) => {
			const env = await fixture(test);
			const lock = await env.acquire();
			await env.call({ op: "stage", ...owner(lock) });
			await env.sql("INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('repair','repair',0,9999999999999)");
			await env.sql("UPDATE edit_lock SET expires=0");
			if (kind === "cutover")
				await env.sql(`INSERT INTO cutover VALUES(1,1,NULL,NULL,'${lock.id}','${lock.holder_family}','working',NULL)`);
			if (kind === "restore")
				await env.sql(
					`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq,lock_id,lock_family) VALUES('restore','hash','repair','missing','failed',0,'${lock.id}','${lock.holder_family}')`,
				);
			if (kind === "source")
				await env.sql(`INSERT INTO source_batches VALUES('source','${lock.id}','boot',0,'publishing')`);
			if (kind === "ownerless-source" || kind === "ownerless-uppercase-source")
				await env.sql("INSERT INTO source_batches VALUES('source',NULL,'boot',0,'publishing')");
			if (kind === "ownerless-uppercase-source")
				await env.sql("INSERT INTO source_changes(batch,path) VALUES('source','Pages/private')");
			const before = await env.sql("SELECT * FROM staging");
			for (const op of ["acquire", "release", "break"])
				expect(await env.call({ op, ...owner(lock), repair: true })).toMatchObject({
					error: "lock_recovery_conflict",
					transitions: [],
				});
			expect(await env.sql("SELECT * FROM staging")).toEqual(before);
			expect(await env.sql("SELECT id,expires FROM edit_lock")).toEqual([{ id: lock.id, expires: 0 }]);
		},
	);

	it("defers repair break for a matching journal pin without discarding staging", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		await env.call({ op: "stage", ...owner(lock) });
		await env.call({ op: "pin", ...owner(lock) });
		await env.sql("INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('repair','repair',0,9999999999999)");
		await env.sql(`INSERT INTO cutover VALUES(1,1,NULL,NULL,'${lock.id}','${lock.holder_family}','working',NULL)`);
		const before = await env.sql("SELECT * FROM staging");
		expect(await env.call({ op: "break", ...owner(lock), repair: true })).toMatchObject({
			value: { id: lock.id, cutover_in_flight: 1, pending_release: "broken" },
			transitions: [{ deferred: true }],
		});
		expect(await env.sql("SELECT * FROM staging")).toEqual(before);
	});

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
	}, 15000);

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
	}, 15000);

	it.for(["break", "revoke"])("defers %s until cutover finalization", async (op, test) => {
		const env = await fixture(test);
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
	});

	it.for([true, false])("preserves borrowed staging after finalization with succeeded=%s", async (succeeded, test) => {
		const env = await fixture(test);
		const lock = await env.acquire({ ttl: 60 });
		await env.call({ op: "stage", ...owner(lock), content: "unfinished editor bytes" });
		await env.call({ op: "stage", ...owner(lock), path: "app/deleted.ts", content: null });
		const before = await env.sql("SELECT * FROM staging ORDER BY path");
		expect(await env.call({ op: "pin", ...owner(lock), resetPin: 1 })).toMatchObject({
			value: { id: lock.id, cutover_in_flight: 1, reset_pin: 1 },
		});
		await env.sql("UPDATE edit_lock SET expires = 0");
		expect(await env.call({ op: "finish", ...owner(lock), succeeded, release: true })).toMatchObject({
			value: { id: lock.id, cutover_in_flight: 0, reset_pin: 0 },
		});
		expect(await env.sql("SELECT * FROM staging ORDER BY path")).toEqual(before);
		const resumed = Schema.decodeUnknownSync(Schema.Struct({ value: Lock }))(await env.call({ op: "inspect" })).value;
		expect(resumed.expires).toBeGreaterThan(Date.now());
		// Borrowing is one operation: the editor's next ordinary successful publication consumes its own overlay.
		await env.call({ op: "pin", ...owner(lock) });
		await env.call({ op: "finish", ...owner(lock), succeeded: true });
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
	});

	it("recovers a borrowed pin across processes while retaining exact staging and renewing expired ownership", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire({ ttl: 60 });
		await env.call({ op: "stage", ...owner(lock), content: "unpublished replacement" });
		await env.call({ op: "stage", ...owner(lock), path: "app/deleted.ts", content: null });
		const before = await env.sql("SELECT * FROM staging ORDER BY path");
		await env.call({ op: "pin", ...owner(lock), resetPin: 1 });
		await env.sql("UPDATE edit_lock SET expires = 0");
		// Every fixture invocation is a new process: neither a closure nor a service instance retains the borrowing flag.
		expect(await env.call({ op: "inspect" })).toMatchObject({
			value: { id: lock.id, cutover_in_flight: 1, reset_pin: 1 },
		});
		expect(await env.call({ op: "recover" })).toMatchObject([{ type: "interrupted", staged: [] }]);
		expect(await env.sql("SELECT * FROM staging ORDER BY path")).toEqual(before);
		const resumed = Schema.decodeUnknownSync(Schema.Struct({ value: Lock }))(await env.call({ op: "inspect" })).value;
		expect(resumed).toMatchObject({ id: lock.id, cutover_in_flight: 0, reset_pin: 0 });
		expect(resumed.expires).toBeGreaterThan(Date.now());
		expect(await env.call({ op: "recover" })).toEqual([]);
		expect(await env.sql("SELECT * FROM staging ORDER BY path")).toEqual(before);
		expect(await env.call({ op: "stage", ...owner(lock), content: "editor resumed" })).toMatchObject({
			value: { id: lock.id },
		});
	});

	it.for([
		{ action: "break", completion: "finish" },
		{ action: "revoke", completion: "finish" },
		{ action: "break", completion: "recover" },
		{ action: "revoke", completion: "recover" },
	])("honors a pending $action on a borrowed pin during $completion", async ({ action, completion }, test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		await env.call({ op: "stage", ...owner(lock) });
		await env.call({ op: "pin", ...owner(lock), resetPin: 1 });
		expect(await env.call({ op: action, ...owner(lock) })).toMatchObject({
			value: { cutover_in_flight: 1, reset_pin: 1 },
			transitions: [{ deferred: true }],
		});
		expect(await env.call({ op: "acquire", family: "other" })).toMatchObject({ error: "cutover_in_flight" });
		const completed = await env.call({ op: completion, ...owner(lock), succeeded: true });
		const transition = { type: action === "break" ? "broken" : "revoked", staged: ["app/main.ts"] };
		expect(completed).toMatchObject(
			completion === "finish" ? { value: null, transitions: [transition] } : [transition],
		);
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: null });
	});

	it.for([true, false])(
		"releases boot-created reset ownership after finalization with succeeded=%s",
		async (succeeded, test) => {
			const env = await fixture(test);
			const lock = await env.acquire({ family: "reset-human" });
			await env.call({ op: "pin", ...owner(lock), resetPin: 2 });
			await env.sql("UPDATE edit_lock SET expires = 0");
			expect(await env.call({ op: "finish", ...owner(lock), succeeded })).toMatchObject({
				value: null,
				transitions: [{ type: "released", staged: [] }],
			});
			expect(await env.call({ op: "inspect" })).toMatchObject({ value: null });
			expect((await env.acquire({ family: "next-editor" })).holder_family).toBe("next-editor");
		},
	);

	it("drops interrupted boot-created reset ownership on restart", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire({ family: "reset-human" });
		await env.call({ op: "pin", ...owner(lock), resetPin: 2 });
		expect(await env.call({ op: "recover" })).toMatchObject([{ type: "interrupted", staged: [] }]);
		expect(await env.call({ op: "inspect" })).toMatchObject({ value: null });
		expect((await env.acquire({ family: "next-editor" })).holder_family).toBe("next-editor");
	});

	it("migrates an ordinary v15 pin without granting borrowed staging preservation", async (test) => {
		const env = await fixture(test);
		const lock = await env.acquire();
		await env.call({ op: "stage", ...owner(lock), content: "legacy pending bytes" });
		await env.call({ op: "pin", ...owner(lock) });
		await env.sql("ALTER TABLE edit_lock DROP COLUMN reset_pin");
		await env.sql("ALTER TABLE backups DROP COLUMN legacy_store_id");
		await env.sql("DROP TABLE IF EXISTS boot_migrations");
		await env.sql("ALTER TABLE backups DROP COLUMN engine");
		await env.sql("PRAGMA user_version=15");
		const before = await env.sql("SELECT * FROM staging");
		await env.call({ op: "init" });
		expect(await env.sql("PRAGMA user_version")).toEqual([{ user_version: 20 }]);
		expect(await env.call({ op: "inspect" })).toMatchObject({
			value: { id: lock.id, cutover_in_flight: 1, reset_pin: 0 },
		});
		expect(await env.sql("SELECT * FROM staging")).toEqual(before);
		expect(await env.call({ op: "recover" })).toMatchObject([{ type: "interrupted", staged: ["app/main.ts"] }]);
		expect(await env.sql("SELECT * FROM staging")).toEqual([]);
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
	}, 15000);
});
