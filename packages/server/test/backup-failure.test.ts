import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

it("does not invite another backup when child cleanup fails after the copy was catalogued", async (test) => {
	const fixture = await resetFixture(test);
	const filename = join(fixture.boot, "src/database-backup.ts");
	const source = await readFile(filename, "utf8");
	const needle = "return record;";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(filename, source.replace(needle, 'return yield* new ChildError({code:"boot_shutting_down"});'));
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const response = await app.post("/_boot/db/backup", {}, cookie);
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: {
			code: "boot_shutting_down",
			retriable: false,
			hint: expect.stringContaining("copy may already exist"),
		},
	});
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM backups WHERE reason='manual'", "boot.db")).toEqual([
		{ count: 1 },
	]);
	const catalog = await fetch(`${app.url}/_boot/db/backups`, { headers: { cookie } });
	expect(catalog.status).toBe(200);
	expect(await catalog.json()).toMatchObject({ items: [{ reason: "manual" }] });
}, 30000);
