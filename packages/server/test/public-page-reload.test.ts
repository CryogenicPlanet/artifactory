import { sourcePut } from "./fixtures/source-put.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("serves anonymous GET and HEAD while a source reload holds its operation gate in rehearsal", async (test) => {
	const fixture = await conversation(test);
	await mkdir(join(fixture.root, "pages/guide"), { recursive: true });
	await writeFile(join(fixture.root, "pages/guide/file.md"), "# Published during reload");
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect(
		(
			await fetch(`${app.url}/api/topics/guide`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true } }),
			})
		).status,
	).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
	const needle = "const server = Effect.gen(function* () {";
	expect(source.split(needle)).toHaveLength(2);
	const edited = source.replace(
		needle,
		`${needle}\nif ((yield* Config.String("STATE")) === "rehearsal") yield* Effect.sleep("3 seconds");`,
	);
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: edited,
			})
		).status,
	).toBe(200);
	let settled = false;
	const reload = app.post("/api/reload?release=1", {}, cookie).then((response) => {
		settled = true;
		return response;
	});
	await expect
		.poll(() => fixture.sql("SELECT COUNT(*) count FROM generations WHERE n>1 AND status='starting'", "boot.db"), {
			timeout: 5000,
		})
		.toEqual([{ count: 1 }]);
	expect(settled).toBe(false);
	const response = await fetch(`${app.url}/p/guide/file.md`);
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("Published during reload");
	const head = await fetch(`${app.url}/p/guide/file.md`, { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
	expect(settled).toBe(false);
	const completed = await reload;
	expect(completed.status).toBe(200);
	expect(await completed.json()).toMatchObject({ status: "live" });
	expect((await fetch(`${app.url}/p/guide/file.md`)).status).toBe(200);
}, 20000);
