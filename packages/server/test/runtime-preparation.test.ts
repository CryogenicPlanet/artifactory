import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("keeps writes live through failed preparation and serves an edited UI from a retained generation", async (test) => {
	await promisify(execFile)("bun", [join(import.meta.dirname, "../stage-runtime.ts")]);
	const seed = join(import.meta.dirname, "../dist/runtime-seed");
	const fixture = await conversation(test);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie, 90000);
	const headers = { cookie, origin: "https://comms.test" };
	const put = (path: string, content: string) =>
		fetch(`${app.url}/api/fs/app/${path}?reload=0`, {
			method: "PUT",
			headers,
			body: content,
		});
	const originalManifest = await readFile(join(seed, "package.json"), "utf8");
	const originalConfig = await readFile(join(seed, "ui/vite.config.ts"), "utf8");
	const originalHtml = await readFile(join(seed, "ui/index.html"), "utf8");
	const receipts: number[] = [];
	const send = async () => {
		const response = await app.post(
			"/api/messages",
			{ topic: "preparation", body: "acknowledged during preparation" },
			cookie,
		);
		expect(response.status).toBe(200);
		receipts.push((await response.json()).seq);
	};
	await send();
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const brokenManifest = originalManifest.replace(/"effect":\s*"[^"]+"/, '"effect": "0.0.0"');
	expect(brokenManifest).not.toBe(originalManifest);
	expect((await put("package.json", brokenManifest)).status).toBe(200);
	const failedInstall = app.post("/api/reload", {}, cookie);
	void failedInstall.catch(() => undefined);
	await send();
	expect(await (await failedInstall).json()).toMatchObject({ status: "failed" });
	expect(await readFile(join(fixture.root, "app/package.json"), "utf8")).toBe(originalManifest);

	expect((await put("package.json", originalManifest)).status).toBe(200);
	const entered = join(fixture.root, "build-entered");
	const release = join(fixture.root, "build-release");
	const brokenConfig = `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(entered)}, "entered");
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 25));
throw new Error("deliberate UI build failure"); export default {};`;
	expect((await put("ui/vite.config.ts", brokenConfig)).status).toBe(200);
	let buildSettled = false;
	const failedBuild = app.post("/api/reload", {}, cookie).finally(() => {
		buildSettled = true;
	});
	// Observe rejection immediately; assertions below still await the original request.
	void failedBuild.catch(() => undefined);
	try {
		// A fresh install (up to 60s) and dependency copy precede entry into the build.
		await expect.poll(() => readFile(entered, "utf8").catch(() => ""), { timeout: 90000 }).toBe("entered");
		await Promise.race([
			send(),
			delay(3000).then(() => {
				throw Error("Message blocked behind preparation");
			}),
		]);
		const status = await (await fetch(`${app.url}/_boot/status`, { headers })).json();
		expect(status.traffic.frozen).toBe(false);
		expect(buildSettled).toBe(false);
	} finally {
		await writeFile(release, "release");
		await failedBuild.catch(() => undefined);
	}
	expect(await (await failedBuild).json()).toMatchObject({ status: "failed" });
	expect(await readFile(join(fixture.root, "app/ui/vite.config.ts"), "utf8")).toBe(originalConfig);

	expect((await put("ui/vite.config.ts", originalConfig)).status).toBe(200);
	const editedHtml = originalHtml.replace(/<title>[^<]*<\/title>/, "<title>Prepared UI generation</title>");
	expect(editedHtml).not.toBe(originalHtml);
	expect((await put("ui/index.html", editedHtml)).status).toBe(200);
	expect(await (await app.post("/api/reload?release=1", {}, cookie)).json()).toMatchObject({
		status: "live",
		lock: null,
	});
	await send();
	expect(await (await fetch(`${app.url}/`, { headers })).text()).toContain("Prepared UI generation");
	expect(await fixture.sql("SELECT seq FROM messages WHERE topic='preparation' ORDER BY seq")).toEqual(
		receipts.map((seq) => ({ seq })),
	);
	const generations = await (await fetch(`${app.url}/api/generations`, { headers })).json();
	const acceptedGeneration = generations.last_good;
	const dependencyStore = await realpath(join(fixture.root, "gen", String(acceptedGeneration), "source/node_modules"));
	expect(dependencyStore.startsWith(`${await realpath(fixture.root)}/`)).toBe(true);
	await app.stop();
	await writeFile(join(fixture.root, "app/ui/index.html"), "uncommitted external change");
	const resumed = await fixture.launch(join(seed, "server.ts"));
	const again = await resumed.login();
	await resumed.ready(again);
	const resumedGenerations = await (
		await fetch(`${resumed.url}/api/generations`, { headers: { cookie: again } })
	).json();
	expect(resumedGenerations.last_good).toBe(acceptedGeneration);
	expect(await (await fetch(`${resumed.url}/`, { headers: { cookie: again } })).text()).toContain(
		"Prepared UI generation",
	);
	expect(await fixture.sql("SELECT seq FROM messages WHERE topic='preparation' ORDER BY seq")).toEqual(
		receipts.map((seq) => ({ seq })),
	);
}, 180000);
