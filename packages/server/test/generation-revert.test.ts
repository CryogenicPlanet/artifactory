import { sourcePut } from "./fixtures/source-put.ts";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
import { preparationPhases } from "./fixtures/preparation-phases.ts";

it("restores a retained generation's whole source and manifest through cutover without restoring messages", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const manifest = await readFile(join(import.meta.dirname, "fixtures/no-ui-runtime/package.json"), "utf8");
	const lockfile = await readFile(join(import.meta.dirname, "fixtures/no-ui-runtime/bun.lock"), "utf8");
	await writeFile(join(seed, "package.json"), manifest);
	await writeFile(join(seed, "bun.lock"), lockfile);
	// Keep the frozen manifest and its required installer patch together.
	await mkdir(join(seed, "patches"));
	for (const patch of [
		"@effect%2Fsql-mysql2@4.0.0-rc.113.patch",
		"@effect%2Fsql-pg@4.0.0-rc.113.patch",
		"effect@4.0.0-rc.113.patch",
	]) {
		await cp(join(import.meta.dirname, "../../../patches", patch), join(seed, "patches", patch));
	}
	// Keep real editable workspaces; this no-UI fixture installs only its actual server imports.
	for (const workspace of ["protocol", "storage"]) {
		await mkdir(join(seed, workspace));
		for (const file of ["src", "docs", "package.json"])
			await cp(join(import.meta.dirname, `../../${workspace}`, file), join(seed, workspace, file), { recursive: true });
	}
	await writeFile(join(seed, "retained.sh"), "#!/bin/sh\necho retained\n");
	await chmod(join(seed, "retained.sh"), 0o750);
	const diagnostics = await preparationPhases(fixture.root);
	const app = await fixture.launch(join(seed, "server.ts"), diagnostics.launcher);
	await app.setup();
	const cookie = await app.login();
	// Cold runtime dependency preparation installs, copies and fsyncs the complete tree.
	try {
		await app.ready(cookie, 60000);
	} catch (cause) {
		// Snapshot phase evidence before process cleanup; retain the original readiness error.
		throw new Error(`Initial preparation phases: ${JSON.stringify(diagnostics.read(app.output()))}`, { cause });
	}
	const request = (path: string, method: string, body?: string) =>
		(method === "PUT" ? sourcePut : fetch)(`${app.url}/api/fs/${path}?reload=0`, {
			method,
			headers: { cookie, origin: "https://comms.test" },
			...(body === undefined ? {} : { body }),
		});
	expect((await app.post("/api/revert", { generation: 1 }, cookie)).status).toBe(423);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect((await request("app/package.json", "PUT", `${manifest}\n`)).status).toBe(200);
	expect((await request("app/retained.sh", "DELETE")).status).toBe(200);
	expect((await request("app/new-only.txt", "PUT", "must disappear")).status).toBe(200);
	const reloaded = await (await app.post("/api/reload", {}, cookie)).json();
	expect(reloaded, JSON.stringify(reloaded)).toMatchObject({ status: "live" });
	expect(
		(await app.post("/api/messages", { topic: "generation", body: "written after original snapshot" }, cookie)).status,
	).toBe(200);
	const restored = await app.post("/api/revert", { generation: 1 }, cookie, "generation-receipt");
	expect(restored.status).toBe(200);
	const outcome = await restored.json();
	expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "live" });
	expect(await (await app.post("/api/revert", { generation: 1 }, cookie, "generation-receipt")).json()).toEqual(
		outcome,
	);
	await app.ready(cookie);
	expect(await readFile(join(fixture.root, "app/package.json"), "utf8")).toBe(manifest);
	expect(await readFile(join(fixture.root, "app/bun.lock"), "utf8")).toBe(lockfile);
	expect(await readFile(join(fixture.root, "app/retained.sh"), "utf8")).toBe("#!/bin/sh\necho retained\n");
	expect((await stat(join(fixture.root, "app/retained.sh"))).mode & 0o777).toBe(0o750);
	expect((await request("app/new-only.txt", "GET")).status).toBe(404);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual([
		{ body: "written after original snapshot" },
	]);
	expect(
		(await app.post("/api/messages", { topic: "generation", body: "new generation still writes" }, cookie)).status,
	).toBe(200);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect(await fixture.sql("SELECT good FROM generations ORDER BY n", "boot.db")).toEqual([
		{ good: 1 },
		{ good: 1 },
		{ good: 1 },
	]);
	// Whole-source restore prepares three generations, including synced dependency copies.
}, 180000);

it("refuses invalid, mixed and unavailable generation selectors and preserves unrelated staging", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(fixture.root, "app/server.ts"), "utf8");
	for (const input of [
		{ generation: 0 },
		{ generation: -1 },
		{ generation: 1.5 },
		{ generation: "1" },
		{ generation: null },
		{ generation: Number.MAX_SAFE_INTEGER + 1 },
		{ generation: 1, path: "app/server.ts" },
		{ generation: 1, batch: "other" },
		{ generation: 1, version: 1 },
	])
		expect((await app.post("/api/revert", input, cookie)).status).toBe(400);
	const missing = await app.post("/api/revert", { generation: 987654 }, cookie);
	expect(missing.status).toBe(400);
	expect(await missing.json()).toMatchObject({ error: { code: "generation_unavailable" } });
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/held.txt?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: "unrelated repair",
			})
		).status,
	).toBe(200);
	const held = await app.post("/api/revert", { generation: 1 }, cookie);
	expect(held.status).toBe(423);
	expect(await held.json()).toMatchObject({ error: { code: "staging_not_empty" } });
	expect(await fixture.sql("SELECT path, CAST(content AS TEXT) AS content FROM staging", "boot.db")).toEqual([
		{ path: "app/held.txt", content: "unrelated repair" },
	]);
	expect(await readFile(join(fixture.root, "app/server.ts"), "utf8")).toBe(source);
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
}, 20000);

it("refuses a symlink in a retained generation before staging or replacing source", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const original = await readFile(join(fixture.root, "app/server.ts"), "utf8");
	const outside = join(fixture.root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "secret.txt"), "never read or stage");
	await symlink(outside, join(fixture.root, "gen/1/source/injected"));
	const response = await app.post("/api/revert", { generation: 1 }, cookie);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ error: { code: "invalid_path" } });
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
	expect(await readFile(join(fixture.root, "app/server.ts"), "utf8")).toBe(original);
	expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("never read or stage");
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
	await rm(join(fixture.root, "gen/1/source/injected"));
	await app.ready(cookie);
}, 20000);

it("keeps the original generation selection after a lost response and restart and refuses key reuse", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	expect(
		await (
			await sourcePut(`${app.url}/api/fs/app/later.txt`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: "later generation",
			})
		).json(),
	).toMatchObject({ status: "live" });
	const lost = await app.post("/api/revert", { generation: 1 }, cookie, "generation-outcome-lost");
	expect(lost.status).toBe(200);
	await lost.body?.cancel();
	await app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	expect(
		await (await resumed.post("/api/revert", { generation: 1 }, cookie, "generation-outcome-lost")).json(),
	).toMatchObject({ status: "live" });
	expect((await fetch(`${resumed.url}/api/fs/app/later.txt`, { headers: { cookie } })).status).toBe(404);
	for (const input of [{ generation: 2 }, { path: "app/server.ts" }, {}]) {
		const conflicting = await resumed.post("/api/revert", input, cookie, "generation-outcome-lost");
		expect(conflicting.status).toBe(409);
		expect(await conflicting.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
	}
	expect(
		await fixture.sql("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'source-revert-result:%'", "boot.db"),
	).toEqual([{ n: 1 }]);
}, 30000);

it("restores file-directory replacements and exact empty directories from a retained generation", async (test) => {
	const started = performance.now();
	const phases: Array<{ phase: string; at_ms: number }> = [];
	const phase = (name: string) => phases.push({ phase: name, at_ms: Math.round(performance.now() - started) });
	test.onTestFailed(() => Effect.runPromise(Console.error("Tree revert fixture diagnostic", phases)));
	phase("setup_start");
	const fixture = await conversation(test);
	const seed = join(fixture.root, "tree-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(join(seed, "original-file"), "original file bytes");
	await writeFile(join(seed, "stable.txt"), "stable original");
	await mkdir(join(seed, "original-directory"));
	await writeFile(join(seed, "original-directory/nested.txt"), "nested original bytes");
	await mkdir(join(seed, "original-empty"));
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	phase("initial_live");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	let operation = 0;
	const revert = async (input: unknown) => {
		const id = ++operation;
		phase(`revert_${id}_start`);
		const result: unknown = await (await app.post("/api/revert", input, cookie)).json();
		phase(`revert_${id}_response`);
		return result;
	};
	const editable = join(fixture.root, "app");
	await rm(join(editable, "original-file"));
	await mkdir(join(editable, "original-file"));
	await writeFile(join(editable, "original-file/new-child.txt"), "remove this directory tree");
	await rm(join(editable, "original-directory"), { recursive: true });
	await writeFile(join(editable, "original-directory"), "remove this replacement file");
	await rm(join(editable, "original-empty"), { recursive: true });
	await mkdir(join(editable, "new-empty"));
	expect(await revert({ generation: 1 })).toMatchObject({ status: "live" });
	expect(await readFile(join(editable, "original-file"), "utf8")).toBe("original file bytes");
	expect(await readFile(join(editable, "original-directory/nested.txt"), "utf8")).toBe("nested original bytes");
	expect(await readdir(join(editable, "original-directory"))).toEqual(["nested.txt"]);
	expect(await readdir(join(editable, "original-empty"))).toEqual([]);
	expect(await readdir(editable)).not.toContain("new-empty");
	const history = async () =>
		(await (await fetch(`${app.url}/api/fs/app/original-file?history`, { headers: { cookie } })).json()).items[0];
	const restoredBatch = (await history()).batch;
	await writeFile(join(editable, "stable.txt"), "later unrelated edit");
	await writeFile(join(editable, "later-independent.txt"), "later unrelated file");
	for (const selection of [{}, { batch: restoredBatch }]) {
		expect(await revert(selection)).toMatchObject({ status: "live" });
		expect(await readFile(join(editable, "original-file/new-child.txt"), "utf8")).toBe("remove this directory tree");
		expect(await readFile(join(editable, "original-directory"), "utf8")).toBe("remove this replacement file");
		expect(await readdir(join(editable, "new-empty"))).toEqual([]);
		expect(await readdir(editable)).not.toContain("original-empty");
		expect(await readFile(join(editable, "stable.txt"), "utf8")).toBe("later unrelated edit");
		expect(await readFile(join(editable, "later-independent.txt"), "utf8")).toBe("later unrelated file");
	}
	expect(await revert({ generation: 1 })).toMatchObject({ status: "live" });
	const restoredVersion = (await history()).id;
	expect(await revert({ path: "app/original-file" })).toMatchObject({
		status: "live",
	});
	expect(await readFile(join(editable, "original-file/new-child.txt"), "utf8")).toBe("remove this directory tree");
	expect(await readFile(join(editable, "original-directory/nested.txt"), "utf8")).toBe("nested original bytes");
	expect(await readdir(join(editable, "original-empty"))).toEqual([]);
	expect(await readdir(editable)).not.toContain("new-empty");
	expect(await revert({ version: restoredVersion })).toMatchObject({
		status: "live",
	});
	expect(await readFile(join(editable, "original-file"), "utf8")).toBe("original file bytes");
	expect(await readFile(join(editable, "original-directory/nested.txt"), "utf8")).toBe("nested original bytes");
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	await app.ready(cookie);
	phase("assertions_complete");
}, 60000);

it("recreates a missing editable app tree while its saved generation continues serving", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const original = await readFile(join(fixture.root, "app/server.ts"), "utf8");
	await rm(join(fixture.root, "app"), { recursive: true });
	expect(
		(await app.post("/api/messages", { topic: "missing-source", body: "saved child still serves" }, cookie)).status,
	).toBe(200);
	const restored = await app.post("/api/revert", { generation: 1 }, cookie, "generation-receipt");
	expect(restored.status).toBe(200);
	expect(await restored.json()).toMatchObject({ status: "live" });
	expect(await readFile(join(fixture.root, "app/server.ts"), "utf8")).toBe(original);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual([
		{ body: "saved child still serves" },
	]);
	await app.ready(cookie);
}, 25000);

it("keeps source and live writes intact when generation dependency preparation fails and permits a repaired retry", async (test) => {
	const started = performance.now();
	const phases: Array<{ phase: string; at_ms: number }> = [];
	const phase = (name: string) => phases.push({ phase: name, at_ms: Math.round(performance.now() - started) });
	test.onTestFinished(() => Effect.runPromise(Console.error("Generation preparation retry phases", phases)));
	phase("setup_start");
	const fixture = await conversation(test);
	const seed = join(fixture.root, "preparation-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const manifest = await readFile(join(import.meta.dirname, "fixtures/no-ui-runtime/package.json"), "utf8");
	const lockfile = await readFile(join(import.meta.dirname, "fixtures/no-ui-runtime/bun.lock"), "utf8");
	await writeFile(join(seed, "package.json"), manifest);
	await writeFile(join(seed, "bun.lock"), lockfile);
	// Keep the frozen manifest and its required installer patch together.
	await mkdir(join(seed, "patches"));
	for (const patch of [
		"@effect%2Fsql-mysql2@4.0.0-rc.113.patch",
		"@effect%2Fsql-pg@4.0.0-rc.113.patch",
		"effect@4.0.0-rc.113.patch",
	]) {
		await cp(join(import.meta.dirname, "../../../patches", patch), join(seed, "patches", patch));
	}
	// Keep real editable workspaces; this no-UI fixture installs only its actual server imports.
	for (const workspace of ["protocol", "storage"]) {
		await mkdir(join(seed, workspace));
		for (const file of ["src", "docs", "package.json"])
			await cp(join(import.meta.dirname, `../../${workspace}`, file), join(seed, workspace, file), { recursive: true });
	}
	phase("seed_copied");
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	// Cold runtime dependency preparation installs, copies and fsyncs the complete tree.
	phase("initial_preparation_wait");
	await app.ready(cookie, 60000);
	phase("initial_live");
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const original = await readFile(join(fixture.root, "app/server.ts"), "utf8");
	const retained = join(fixture.root, "gen/1/source");
	// Test-only trusted snapshot repair: retain valid provenance while forcing the real installer to reject the lock.
	const refreshProvenance = async () => {
		const entries: Array<readonly [string, string | null, number | null, boolean]> = [];
		const walk = async (name: string): Promise<void> => {
			const filename = name === "app" ? retained : join(retained, name.slice(4));
			const info = await stat(filename);
			if (info.isDirectory()) {
				entries.push([name, null, null, true]);
				for (const child of (await readdir(filename)).sort()) {
					const childName = `${name}/${child}`;
					if (child === "node_modules" || child === ".vite" || childName === "app/ui/dist") continue;
					await walk(childName);
				}
			} else
				entries.push([
					name,
					createHash("sha256")
						.update(await readFile(filename))
						.digest("hex"),
					info.mode & 0o777,
					false,
				]);
		};
		await walk("app");
		await writeFile(`${retained}.editable`, `1\n${JSON.stringify(entries)}\n`);
	};
	await writeFile(join(retained, "package.json"), `${manifest}\n`);
	await writeFile(join(retained, "bun.lock"), "invalid frozen lockfile !");
	await writeFile(join(retained, "candidate-only.txt"), "must not publish before preparation");
	await refreshProvenance();
	expect(
		(await app.post("/api/messages", { topic: "preparation", body: "before failed preparation" }, cookie)).status,
	).toBe(200);
	phase("invalid_lock_revert_start");
	const failed = await app.post("/api/revert", { generation: 1 }, cookie);
	phase("invalid_lock_revert_response");
	expect(failed.status).toBe(200);
	expect(await failed.json()).toMatchObject({ status: "failed", lock: { cutover_in_flight: 0 } });
	expect(await readFile(join(fixture.root, "app/server.ts"), "utf8")).toBe(original);
	expect(await readFile(join(fixture.root, "app/package.json"), "utf8")).toBe(manifest);
	expect(await readFile(join(fixture.root, "app/bun.lock"), "utf8")).toBe(lockfile);
	expect(await readdir(join(fixture.root, "app"))).not.toContain("candidate-only.txt");
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect(
		(await app.post("/api/messages", { topic: "preparation", body: "after failed preparation" }, cookie)).status,
	).toBe(200);
	phase("failed_preparation_assertions_complete");
	await writeFile(join(retained, "package.json"), manifest);
	await writeFile(join(retained, "bun.lock"), lockfile);
	await refreshProvenance();
	phase("repaired_revert_start");
	expect(await (await app.post("/api/revert", { generation: 1 }, cookie)).json()).toMatchObject({ status: "live" });
	phase("repaired_revert_response");
	expect(await readFile(join(fixture.root, "app/candidate-only.txt"), "utf8")).toBe(
		"must not publish before preparation",
	);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual([
		{ body: "before failed preparation" },
		{ body: "after failed preparation" },
	]);
	await app.ready(cookie);
	phase("assertions_complete");
	// Linux measured 26.1s cold preparation + 2.1s refusal + 29.1s repaired preparation (58.7s total).
	// Budget both full preparations together; their individual readiness and production deadlines remain unchanged.
}, 120000);

it("refuses missing, malformed or aliased source provenance and missing retained source without changing editable bytes", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const original = await readFile(join(fixture.root, "app/server.ts"), "utf8");
	const retained = join(fixture.root, "gen/1/source");
	const marker = `${retained}.editable`;
	const provenance = await readFile(marker, "utf8");
	expect(provenance).toMatch(/^1\n\[/);
	const unavailable = async () => {
		const response = await app.post("/api/revert", { generation: 1 }, cookie);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "generation_unavailable" } });
		expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual([]);
		expect(await readFile(join(fixture.root, "app/server.ts"), "utf8")).toBe(original);
		expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 0 }]);
	};
	await rm(marker);
	await unavailable();
	await writeFile(marker, "not source provenance\n");
	await unavailable();
	await writeFile(marker, provenance);
	await rename(marker, `${marker}.saved`);
	await symlink(`${marker}.saved`, marker);
	await unavailable();
	await rm(marker);
	await rename(`${marker}.saved`, marker);
	await rename(retained, `${retained}.saved`);
	await unavailable();
	await symlink(`${retained}.saved`, retained);
	await unavailable();
	await rm(retained);
	await rename(`${retained}.saved`, retained);
	const optional = join(retained, "ext/standup.ts");
	const optionalBytes = await readFile(optional);
	const optionalMode = (await stat(optional)).mode & 0o777;
	await rm(optional);
	await unavailable();
	await writeFile(optional, optionalBytes, { mode: optionalMode });
	await app.ready(cookie);
}, 25000);
