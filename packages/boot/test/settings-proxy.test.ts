import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { launch } from "./fixtures/proxy-launch.ts";

test("configured public paths preserve auth floors and are revoked without restarting", async (context) => {
	const app = await launch(context);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const set = async (key: string, value: string) =>
		promisify(execFile)("bun", [
			"-e",
			'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1]); db.query("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(process.argv[2],process.argv[3]); db.close();',
			join(app.data, "boot.db"),
			key,
			value,
		]);
	expect((await fetch(`${app.url}/echo`)).status).toBe(401);
	await set("public_paths", '["/echo"]');
	expect((await fetch(`${app.url}/echo`)).status).toBe(200);
	expect((await fetch(`${app.url}/echo`, { method: "HEAD" })).status).toBe(200);
	expect((await fetch(`${app.url}/echo`, { method: "POST" })).status).toBe(401);
	expect((await fetch(`${app.url}/echo`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
	expect((await fetch(`${app.url}/echo`, { headers: { cookie: "__Host-comms_session=invalid" } })).status).toBe(401);
	await set("event_retention", "broken");
	expect((await fetch(`${app.url}/echo`)).status).toBe(200);
	expect((await fetch(`${app.url}/init`)).status).toBe(200);
	await set("public_paths", "broken");
	expect((await fetch(`${app.url}/echo`)).status).toBe(401);
	expect((await fetch(`${app.url}/init`)).status).toBe(200);
	expect((await fetch(`${app.url}/health`)).status).toBe(200);
	expect((await fetch(`${app.url}/_boot`)).status).toBe(200);
	expect((await app.fetch(`${app.url}/_boot/status`)).status).toBe(200);
});
