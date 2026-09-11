import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it(
	"keeps authenticated physical source diagnostics available after an unresolved page publication restart",
	{ timeout: 30000 },
	async (test) => {
		const fixture = await conversation(test);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const source = await readFile(join(fixture.root, "app/server.ts"), "utf8");
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		expect(
			(
				await fetch(`${app.url}/api/fs/app/server.ts?reload=0`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: `${source}\n// staged repair`,
				})
			).status,
		).toBe(200);
		await mkdir(join(fixture.root, "pages/new"), { recursive: true });
		await writeFile(join(fixture.root, "pages/new/index.md"), "physical page");
		await app.stop();
		// Preserve uncertain publication evidence; this fixture does not infer it from a database restore.
		await fixture.sql(
			"INSERT INTO topic_moves VALUES('fixture','old','new','fixture',NULL,'{}','pages_published',1)",
			"boot.db",
		);
		await fixture.sql(
			"INSERT INTO topic_page_moves VALUES('fixture','pages/old','pages/new','fixture',NULL,'published')",
			"boot.db",
		);
		await fixture.sql("UPDATE edit_lock SET expires=0", "boot.db");
		const evidence = async () =>
			Promise.all([
				fixture.sql("SELECT * FROM edit_lock", "boot.db"),
				fixture.sql("SELECT lock_id,path,hex(content) AS content,sha,at,mode FROM staging", "boot.db"),
				fixture.sql("SELECT * FROM topic_moves", "boot.db"),
				fixture.sql("SELECT * FROM topic_page_moves", "boot.db"),
				fixture.sql("SELECT * FROM source_batches", "boot.db"),
			]);
		const before = await evidence();
		const restarted = await fixture.launch();
		await expect
			.poll(
				async () =>
					(await (await fetch(`${restarted.url}/_boot/status`, { headers: { cookie } })).json()).source_recovery_error,
				{ timeout: 10000 },
			)
			.toContain("topic_move_recovery_required");
		const get = (path: string) => fetch(`${restarted.url}/api/fs/${path}`, { headers: { cookie } });
		expect((await fetch(`${restarted.url}/api/fs/app/server.ts`)).status).toBe(401);
		for (const [name, content] of [
			["app/server.ts", source],
			["pages/new/index.md", "physical page"],
		] as const) {
			const response = await get(name);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(content);
			const history = await get(`${name}?history=1`);
			expect(history.status).toBe(200);
			expect(await history.json()).toEqual({ items: [] });
		}
		for (const [directory, name] of [
			["app/", "server.ts"],
			["pages/new/", "index.md"],
		] as const) {
			const response = await get(directory);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ items: expect.arrayContaining([{ name, type: "file" }]) });
		}
		for (const [method, path] of [
			["PUT", "/api/fs/app/server.ts?reload=0"],
			["PUT", "/api/fs/pages/new/index.md"],
			["DELETE", "/api/lock"],
			["POST", "/api/lock"],
			["POST", "/api/reload"],
			["POST", "/api/revert"],
		] as const) {
			expect(
				(
					await fetch(`${restarted.url}${path}`, {
						method,
						headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
						body: "{}",
					})
				).status,
			).toBe(503);
		}
		expect(await evidence()).toEqual(before);
		expect(await readFile(join(fixture.root, "app/server.ts"), "utf8")).toBe(source);
		expect(await readFile(join(fixture.root, "pages/new/index.md"), "utf8")).toBe("physical page");
	},
);
