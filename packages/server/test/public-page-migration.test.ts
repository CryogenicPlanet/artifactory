import { sourcePut } from "./fixtures/source-put.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("replaces public grants after editable migrations privatize, tombstone or remove topics", async (test) => {
	const fixture = await conversation(test);
	const names = ["kept", "private", "deleted", "dropped"];
	for (const name of names) {
		await mkdir(join(fixture.root, "pages", name), { recursive: true });
		await writeFile(join(fixture.root, "pages", name, "file.md"), `# ${name}`);
	}
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	for (const name of names) {
		expect(
			(
				await fetch(`${app.url}/api/topics/${name}`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
					body: JSON.stringify({ meta: { public: true } }),
				})
			).status,
		).toBe(200);
		expect((await fetch(`${app.url}/p/${name}/file.md`)).status).toBe(200);
	}
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const stage = (name: string, body: string) =>
		sourcePut(`${app.url}/api/fs/app/migrations/${name}.ts?reload=0`, {
			method: "PUT",
			headers: { cookie, origin: "https://comms.test" },
			body: `import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; ${body} });`,
		});
	expect(
		(
			await stage(
				"002_policy",
				`
if (process.env.STATE === "rehearsal") yield* Effect.sleep("3 seconds");
yield* sql\`UPDATE topics SET meta='{"public":false}' WHERE path='private'\`;
yield* sql\`UPDATE topics SET deleted_at=1 WHERE path='deleted'\`;
yield* sql\`DELETE FROM topics WHERE path='dropped'\`;
`,
			)
		).status,
	).toBe(200);
	let settled = false;
	const reload = app.post("/api/reload", {}, cookie).then((result) => {
		settled = true;
		return result;
	});
	await expect
		.poll(() => fixture.sql("SELECT count(*) count FROM generations WHERE n>1 AND status='starting'", "boot.db"), {
			timeout: 5000,
		})
		.toEqual([{ count: 1 }]);
	expect(settled).toBe(false);
	for (const name of names) expect((await fetch(`${app.url}/p/${name}/file.md`)).status).toBe(200);
	expect(settled).toBe(false);
	expect(await (await reload).json()).toMatchObject({ status: "live" });
	expect((await fetch(`${app.url}/p/kept/file.md`)).status).toBe(200);
	for (const name of names.slice(1)) expect((await fetch(`${app.url}/p/${name}/file.md`)).status).toBe(401);
	expect(await fixture.sql("SELECT path FROM public_paths ORDER BY path", "boot.db")).toEqual([{ path: "kept" }]);
	expect((await stage("003_empty", `yield* sql\`UPDATE topics SET meta='{}'\`;`)).status).toBe(200);
	expect(await (await app.post("/api/reload?release=1", {}, cookie)).json()).toMatchObject({ status: "live" });
	expect(await fixture.sql("SELECT path FROM public_paths", "boot.db")).toEqual([]);
	expect((await fetch(`${app.url}/p/kept/file.md`)).status).toBe(401);
}, 35000);
