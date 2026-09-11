import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const marker = (value: string) => `export const marker = ${JSON.stringify(value)};\n`;
async function fixture(test: TestContext, missedNotifications = false) {
	const env = await conversation(test);
	const seed = join(env.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await mkdir(join(seed, "ui"));
	const server = await readFile(join(seed, "server.ts"), "utf8");
	const modified = server.replace(
		'if (request.url === "/_kernel/control" && request.method === "POST") {',
		'if (request.url === "/api/watcher-marker") return HttpServerResponse.text(marker);\nif (request.url === "/_kernel/control" && request.method === "POST") {',
	);
	expect(modified).not.toBe(server);
	await writeFile(join(seed, "server.ts"), `import { marker } from "./marker.ts";\n${modified}`);
	await writeFile(join(seed, "marker.ts"), marker("original"));
	const launch = () =>
		env.launch(
			join(seed, "server.ts"),
			missedNotifications ? join(import.meta.dirname, "fixtures/watcher-no-notifications.ts") : undefined,
		);
	const app = await launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const generations = () => env.sql("SELECT n, good FROM generations ORDER BY n", "boot.db");
	const getMarker = async () => (await fetch(`${app.url}/api/watcher-marker`, { headers: { cookie } })).text();
	return { ...env, app, cookie, launch, generations, getMarker, path: join(env.root, "app/marker.ts") };
}

it("versions direct edits with their first before-image, retains a healthy child after failure, and retries only changed source", async (test) => {
	const env = await fixture(test);
	await writeFile(env.path, marker("changed"));
	await expect.poll(env.getMarker, { timeout: 15000 }).toBe("changed");
	expect(
		await env.sql(
			"SELECT agent, CAST(previous_content AS TEXT) AS before, CAST(content AS TEXT) AS after FROM versions WHERE path='app/marker.ts' AND agent='watcher'",
			"boot.db",
		),
	).toEqual([{ agent: "watcher", before: marker("original"), after: marker("changed") }]);
	await writeFile(env.path, "invalid TypeScript !");
	await expect.poll(env.generations, { timeout: 15000 }).toEqual([
		{ n: 1, good: 1 },
		{ n: 2, good: 1 },
		{ n: 3, good: 0 },
	]);
	await expect.poll(async () => env.sql("SELECT * FROM edit_lock", "boot.db"), { timeout: 15000 }).toEqual([]);
	expect(await env.getMarker()).toBe("changed");
	expect(
		(await env.app.post("/api/messages", { topic: "watcher", body: "accepted after bad edit" }, env.cookie)).status,
	).toBe(200);
	await delay(2300);
	expect(await env.generations()).toEqual([
		{ n: 1, good: 1 },
		{ n: 2, good: 1 },
		{ n: 3, good: 0 },
	]);
	await writeFile(env.path, marker("repaired"));
	await expect.poll(env.getMarker, { timeout: 15000 }).toBe("repaired");
	expect(await env.sql("SELECT body FROM messages")).toEqual([{ body: "accepted after bad edit" }]);
}, 45000);

it("preserves another holder's staging and reconciles after release without a new filesystem notification", async (test) => {
	const env = await fixture(test, true);
	expect((await env.app.post("/api/lock", {}, env.cookie)).status).toBe(200);
	expect(
		(
			await fetch(`${env.app.url}/api/fs/app/other.ts?reload=0`, {
				method: "PUT",
				headers: { cookie: env.cookie, origin: "https://comms.test" },
				body: "export const other = 1;",
			})
		).status,
	).toBe(200);
	const temporary = join(env.root, "app/.comms-atomic-replace");
	await writeFile(temporary, marker("after release"));
	await rename(temporary, env.path);
	await delay(2300);
	expect(await env.getMarker()).toBe("original");
	expect(await env.generations()).toEqual([{ n: 1, good: 1 }]);
	expect(await env.sql("SELECT path, CAST(content AS TEXT) AS content FROM staging", "boot.db")).toEqual([
		{ path: "app/other.ts", content: "export const other = 1;" },
	]);
	expect(
		(
			await fetch(`${env.app.url}/api/lock`, {
				method: "DELETE",
				headers: { cookie: env.cookie, origin: "https://comms.test" },
			})
		).status,
	).toBe(200);
	await expect.poll(env.getMarker, { timeout: 15000 }).toBe("after release");
	expect(await env.sql("SELECT path FROM versions WHERE agent='watcher'", "boot.db")).toEqual([
		{ path: "app/marker.ts" },
	]);
}, 30000);

it("sweeps changes made while stopped and ignores generated dependencies, UI output and journal temporary files", async (test) => {
	const env = await fixture(test, true);
	await env.app.stop();
	await writeFile(env.path, marker("offline change"));
	const resumed = await env.launch();
	const cookie = await resumed.login();
	await resumed.ready(cookie);
	const getMarker = async () => (await fetch(`${resumed.url}/api/watcher-marker`, { headers: { cookie } })).text();
	await expect.poll(getMarker, { timeout: 15000 }).toBe("offline change");
	await mkdir(join(env.root, "app/node_modules"), { recursive: true });
	await mkdir(join(env.root, "app/ui/dist"), { recursive: true });
	await writeFile(join(env.root, "app/node_modules/ignored.txt"), "generated dependency");
	await writeFile(join(env.root, "app/ui/dist/ignored.js"), "generated UI");
	await writeFile(join(env.root, "app/.comms-temporary"), "incomplete journal file");
	await delay(2300);
	expect(await env.generations()).toEqual([
		{ n: 1, good: 1 },
		{ n: 2, good: 1 },
	]);
	expect(await getMarker()).toBe("offline change");
}, 30000);

it("rejects an externally changed rehearsal snapshot before history publication and deploys the next complete tree", async (test) => {
	const env = await fixture(test, true);
	const rehearsing = join(env.root, "rehearsing.txt");
	const release = join(env.root, "release-rehearsal.txt");
	const first = `${marker("first observed edit")}
if (process.env.STATE === "rehearsal") {
 await Bun.write(${JSON.stringify(rehearsing)}, "ready");
 for (let attempt = 0; attempt < 1000 && !await Bun.file(${JSON.stringify(release)}).exists(); attempt++) await Bun.sleep(10);
 if (!await Bun.file(${JSON.stringify(release)}).exists()) throw Error("Test rehearsal release timed out");
}
`;
	await writeFile(env.path, first);
	await expect.poll(() => readFile(rehearsing, "utf8").catch(() => ""), { timeout: 15000 }).toBe("ready");
	expect(await env.getMarker()).toBe("original");
	expect(
		(await env.app.post("/api/messages", { topic: "watcher/race", body: "acknowledged during rehearsal" }, env.cookie))
			.status,
	).toBe(200);
	const laterPath = join(env.root, "app/later.txt");
	await writeFile(laterPath, "created after snapshot capture");
	await writeFile(env.path, marker("newer external edit"));
	expect(await env.sql("SELECT path FROM versions WHERE agent='watcher'", "boot.db")).toEqual([]);
	await writeFile(release, "release");
	await expect.poll(env.getMarker, { timeout: 15000 }).toBe("newer external edit");
	expect(await env.generations()).toEqual([
		{ n: 1, good: 1 },
		{ n: 2, good: 0 },
		{ n: 3, good: 1 },
	]);
	expect(await env.sql("SELECT error FROM generations WHERE n=2", "boot.db")).toEqual([
		{ error: expect.stringContaining("external_conflict") },
	]);
	expect(
		await env.sql(
			"SELECT path, CAST(previous_content AS TEXT) AS before, CAST(content AS TEXT) AS after FROM versions WHERE agent='watcher' ORDER BY path",
			"boot.db",
		),
	).toEqual([
		{ path: "app/later.txt", before: null, after: "created after snapshot capture" },
		{ path: "app/marker.ts", before: marker("original"), after: marker("newer external edit") },
	]);
	expect(await readFile(env.path, "utf8")).toBe(marker("newer external edit"));
	expect(await readFile(laterPath, "utf8")).toBe("created after snapshot capture");
	expect(await env.sql("SELECT body FROM messages")).toEqual([{ body: "acknowledged during rehearsal" }]);
}, 35000);

it("repairs a legacy watcher baseline through ordinary authenticated reload without losing existing history", async (test) => {
	const env = await fixture(test);
	await writeFile(env.path, marker("retained history"));
	await expect.poll(env.getMarker, { timeout: 15000 }).toBe("retained history");
	await env.sql(
		"DELETE FROM versions WHERE batch=(SELECT value FROM settings WHERE key='source.watcher_baseline')",
		"boot.db",
	);
	await env.sql(
		"DELETE FROM source_batches WHERE id=(SELECT value FROM settings WHERE key='source.watcher_baseline')",
		"boot.db",
	);
	await env.sql("DELETE FROM settings WHERE key='source.watcher_baseline'", "boot.db");
	await delay(1200);
	expect(await env.getMarker()).toBe("retained history");
	expect((await env.app.post("/api/lock", {}, env.cookie)).status).toBe(200);
	expect(
		(
			await fetch(`${env.app.url}/api/fs/app/marker.ts?reload=0`, {
				method: "PUT",
				headers: { cookie: env.cookie, origin: "https://comms.test" },
				body: marker("legacy current tree"),
			})
		).status,
	).toBe(200);
	expect(await (await env.app.post("/api/reload?release=1", {}, env.cookie)).json()).toMatchObject({ status: "live" });
	expect(await env.getMarker()).toBe("legacy current tree");
	expect(await env.sql("SELECT key FROM settings WHERE key='source.watcher_baseline'", "boot.db")).toEqual([
		{ key: "source.watcher_baseline" },
	]);
	expect(
		await env.sql(
			"SELECT CAST(previous_content AS TEXT) AS before FROM versions WHERE agent='watcher' AND path='app/marker.ts'",
			"boot.db",
		),
	).toEqual([{ before: marker("original") }]);
	expect((await env.app.post("/api/lock", {}, env.cookie)).status).toBe(200);
	expect(await (await env.app.post("/api/revert", { path: "app/marker.ts" }, env.cookie)).json()).toMatchObject({
		status: "live",
	});
	expect(await env.getMarker()).toBe("retained history");
	expect(
		(
			await fetch(`${env.app.url}/api/lock`, {
				method: "DELETE",
				headers: { cookie: env.cookie, origin: "https://comms.test" },
			})
		).status,
	).toBe(200);
	await writeFile(env.path, marker("watcher resumed"));
	await expect.poll(env.getMarker, { timeout: 15000 }).toBe("watcher resumed");
}, 30000);

it("does not reload again after API publication creates new parent directories", async (test) => {
	const env = await fixture(test);
	expect((await env.app.post("/api/lock", {}, env.cookie)).status).toBe(200);
	expect(
		(
			await fetch(`${env.app.url}/api/fs/app/new/nested/file.ts?reload=0`, {
				method: "PUT",
				headers: { cookie: env.cookie, origin: "https://comms.test" },
				body: "export const value = 1;",
			})
		).status,
	).toBe(200);
	expect(await (await env.app.post("/api/reload?release=1", {}, env.cookie)).json()).toMatchObject({ status: "live" });
	const before = await env.generations();
	await delay(2300);
	expect(await env.generations()).toEqual(before);
	expect(await env.sql("SELECT id FROM versions WHERE agent='watcher'", "boot.db")).toEqual([]);
}, 30000);
