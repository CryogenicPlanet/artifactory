import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, type TestContext } from "vitest";
import { storageFixture } from "./storage-maintenance.ts";

export const combinedReceipt = Schema.Struct({
	status: Schema.Literals(["restored", "failed"]),
	backup: Schema.String,
	safety_backup: Schema.NullOr(Schema.String),
	generation: Schema.Int,
	source_generation: Schema.Int,
	restored_to_seq: Schema.Int,
	event_seq: Schema.NullOr(Schema.Int),
	error: Schema.optional(Schema.String),
});

/** Real reloads establish the exact target pre-flip backup; no catalog rows are fabricated. */
export async function combinedFixture(test: TestContext) {
	const fixture = await storageFixture(test);
	const editable = join(fixture.root, "app");
	const targetLarge = "retained source bytes\n".repeat(55000);
	const currentLarge = "newer source bytes\n".repeat(60000);
	const headers = (cookie: string) => ({ cookie, origin: "https://comms.test" });
	const runtime = (current: boolean) => `import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";
export default (api: Api) => Effect.gen(function* () {
 yield* api.migrate("create", "CREATE TABLE combined_fixture(identity TEXT, legacy TEXT)");
 yield* api.migrate("seed", "INSERT INTO combined_fixture VALUES('fixture','retained value')");
 ${current ? `yield* api.migrate("drop-legacy", "ALTER TABLE combined_fixture DROP COLUMN legacy");\nyield* api.migrate("add-current", "ALTER TABLE combined_fixture ADD COLUMN current TEXT DEFAULT 'current value'");` : ""}
 api.route("GET", "/api/combined-version", { description: "Read this fixture generation and schema", scope: "read", handler: (_request, ctx) => Effect.gen(function* () {
  const rows = yield* ctx.read(() => ctx.db\`SELECT ${current ? "current" : "legacy"} value FROM combined_fixture\`);
  return Response.json({ version: "${current ? "current" : "target"}", rows });
 }) });
});`;
	const assertRuntime = async (url: string, cookie: string, target: boolean) => {
		const response = await fetch(`${url}/api/combined-version`, { headers: { cookie } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: target ? "target" : "current",
			rows: [{ value: target ? "retained value" : "current value" }],
		});
	};
	const initialize = async () => {
		await writeFile(join(fixture.root, "packages/server/src/ext/combined-fixture.ts"), runtime(false));
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const stage = async (name: string, body: string) => {
			const response = await fetch(`${app.url}/api/fs/app/${name}?reload=0`, {
				method: "PUT",
				headers: headers(cookie),
				body,
			});
			expect(response.status).toBe(200);
		};
		const create = async (body: string) => {
			expect((await app.post("/api/messages", { topic: "combined", body }, cookie)).status).toBe(200);
		};
		await create("A before target pre-flip");
		await writeFile(join(editable, "target-file"), "retained file");
		await mkdir(join(editable, "target-directory"));
		await writeFile(join(editable, "target-directory/child.txt"), "retained child");
		await mkdir(join(editable, "target-empty"));
		await writeFile(join(editable, "large.txt"), targetLarge);
		await stage("restore-version.txt", "target generation");
		expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "live" });
		await app.ready(cookie);
		const target = (await fixture.status(app.url, cookie)).child.generation;
		if (target === null) throw Error("Missing target generation");
		const saved = (await fixture.backups()).find((row) => row.reason === "pre-flip" && row.generation === target);
		if (!saved) throw Error("Missing target generation's exact pre-flip backup");
		expect(await fixture.sql(`SELECT backup_id FROM generations WHERE n=${target}`, "boot.db")).toEqual([
			{ backup_id: saved.id },
		]);
		await assertRuntime(app.url, cookie, true);
		await create("B after target pre-flip");
		await rm(join(editable, "target-file"));
		await mkdir(join(editable, "target-file"));
		await writeFile(join(editable, "target-file/new-child.txt"), "newer nested file");
		await rm(join(editable, "target-directory"), { recursive: true });
		await writeFile(join(editable, "target-directory"), "newer replacement file");
		await rm(join(editable, "target-empty"), { recursive: true });
		await mkdir(join(editable, "newer-empty"));
		await writeFile(join(editable, "large.txt"), currentLarge);
		await stage("ext/combined-fixture.ts", runtime(true));
		await stage("restore-version.txt", "current generation");
		expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "live" });
		await app.ready(cookie);
		const prior = (await fixture.status(app.url, cookie)).child.generation;
		if (prior === null) throw Error("Missing current generation");
		await assertRuntime(app.url, cookie, false);
		await create("C after current generation");
		await mkdir(join(fixture.root, "pages/combined"), { recursive: true });
		await writeFile(join(fixture.root, "pages/combined/index.md"), "# Pages remain current\n");
		await stage("unrelated-staging.txt", "pending human repair");
		const staging = await fixture.sql("SELECT * FROM staging", "boot.db");
		const lock = await fixture.sql(
			"SELECT id,holder_family,agent,cutover_in_flight,pending_release FROM edit_lock",
			"boot.db",
		);
		const beforeMessages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		// A second live session restores while the first session owns staged source.
		const restoreCookie = await app.login();
		const signed = async (key?: string) => {
			const proof = await app.signedAssertion(
				"generation.restore",
				{
					generation: target,
					withDb: true,
					...(key ? { idempotency_key: key } : {}),
				},
				restoreCookie,
			);
			return (url: string, signal?: AbortSignal) =>
				fetch(`${url}/_boot/revert`, {
					method: "POST",
					...(signal ? { signal } : {}),
					headers: {
						...headers(restoreCookie),
						"content-type": "application/json",
						"X-Comms-Assertion": proof,
						...(key ? { "Idempotency-Key": key } : {}),
					},
					body: JSON.stringify({ generation: target, withDb: true }),
				});
		};
		return { app, cookie, target, prior, saved, beforeMessages, staging, lock, signed, create };
	};
	const assertSource = async (target: boolean) => {
		expect(await readFile(join(editable, "ext/combined-fixture.ts"), "utf8")).toBe(runtime(!target));
		expect(await readFile(join(editable, "restore-version.txt"), "utf8")).toBe(
			target ? "target generation" : "current generation",
		);
		expect(await readFile(join(editable, "large.txt"), "utf8")).toBe(target ? targetLarge : currentLarge);
		if (target) {
			expect(await readFile(join(editable, "target-file"), "utf8")).toBe("retained file");
			expect(await readFile(join(editable, "target-directory/child.txt"), "utf8")).toBe("retained child");
			expect(await readdir(join(editable, "target-empty"))).toEqual([]);
			expect(await readdir(editable)).not.toContain("newer-empty");
		} else {
			expect(await readFile(join(editable, "target-file/new-child.txt"), "utf8")).toBe("newer nested file");
			expect(await readFile(join(editable, "target-directory"), "utf8")).toBe("newer replacement file");
			expect(await readdir(join(editable, "newer-empty"))).toEqual([]);
			expect(await readdir(editable)).not.toContain("target-empty");
		}
		expect(await readFile(join(fixture.root, "pages/combined/index.md"), "utf8")).toBe("# Pages remain current\n");
	};
	return { ...fixture, initialize, assertSource, assertRuntime };
}
