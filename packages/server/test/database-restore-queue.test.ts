import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

it("queues reads across real database restore and rechecks logged-out sessions and restored public grants before dispatch", async (test) => {
	const fixture = await storageFixture(test);
	const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
	const source = await readFile(coordinator, "utf8");
	const frozen = join(fixture.root, "requests-frozen");
	const release = join(fixture.root, "release-restore");
	const needle = "yield* backup.restore(target);";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		coordinator,
		source.replace(
			needle,
			`${needle}
		yield* fs.writeFileString(${JSON.stringify(frozen)}, "ready");
		while (!(yield* fs.exists(${JSON.stringify(release)}))) yield* Effect.sleep("10 millis");`,
		),
	);
	// Observe the real request gate without adding a production debug surface.
	const proxy = join(fixture.root, "packages/boot/src/proxy.ts");
	const proxySource = await readFile(proxy, "utf8");
	const status = "traffic: yield* child.traffic.state,";
	expect(proxySource.split(status)).toHaveLength(2);
	await writeFile(
		proxy,
		proxySource.replace(status, `${status}\nrequest_traffic: yield* child.traffic.requests.state,`),
	);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	const revoked = await app.login();
	await app.ready(cookie);
	await mkdir(join(fixture.root, "pages/public-new"), { recursive: true });
	await mkdir(join(fixture.root, "pages/public-kept"), { recursive: true });
	await writeFile(join(fixture.root, "pages/public-kept/index.md"), "# still public");
	expect(
		(
			await fetch(`${app.url}/api/topics/public-kept`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true } }),
			})
		).status,
	).toBe(200);
	await writeFile(join(fixture.root, "pages/public-new/index.md"), "# private after restore");
	expect((await app.post("/api/messages", { topic: "restore", body: "retained" }, cookie)).status).toBe(200);
	await fixture.force("hourly");
	await expect.poll(async () => (await fixture.backups()).length, { timeout: 10000 }).toBe(1);
	await fixture.cycle();
	const saved = (await fixture.backups())[0];
	if (!saved) throw Error("Missing backup");
	expect((await app.post("/api/messages", { topic: "restore", body: "removed by restore" }, cookie)).status).toBe(200);
	expect(
		(
			await fetch(`${app.url}/api/topics/public-new`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: JSON.stringify({ meta: { public: true } }),
			})
		).status,
	).toBe(200);
	expect((await fetch(`${app.url}/p/public-new/index.md`)).status).toBe(200);
	const proof = await app.signedAssertion("db.restore", { backup: saved.id }, cookie);
	const controller = new AbortController();
	test.onTestFinished(() => controller.abort());
	const restoring = fetch(`${app.url}/_boot/db/restore`, {
		method: "POST",
		signal: controller.signal,
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json", "X-Comms-Assertion": proof },
		body: JSON.stringify({ backup: saved.id }),
	});
	await expect.poll(() => readFile(frozen, "utf8").catch(() => ""), { timeout: 10000 }).toBe("ready");
	expect(await fixture.sql("SELECT COUNT(*) count FROM public_paths", "boot.db")).toEqual([{ count: 0 }]);
	const state = async () =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				request_traffic: Schema.Struct({
					frozen: Schema.Boolean,
					admitted: Schema.Int,
					queued: Schema.Int,
				}),
			}),
		)(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json()).request_traffic;
	const read = (credential?: string) =>
		fetch(`${app.url}/api/messages?topic=restore&since=0&mark=0`, {
			signal: controller.signal,
			headers: credential ? { cookie: credential } : {},
		});
	const allowed = read(cookie);
	const loggedOut = read(revoked);
	const privatePage = fetch(`${app.url}/p/public-new/index.md`, { signal: controller.signal });
	const publicPage = fetch(`${app.url}/p/public-kept/index.md?raw=1`, { signal: controller.signal });
	await expect.poll(state).toEqual({ frozen: true, admitted: 0, queued: 4 });
	expect((await app.post("/_boot/auth/logout", {}, revoked)).status).toBe(204);
	expect((await fetch(`${app.url}/auth/login`)).status).toBe(200);
	await writeFile(release, "continue");
	const outcome = await restoring;
	expect(outcome.status).toBe(200);
	expect(await outcome.json()).toMatchObject({ status: "restored", backup: saved.id });
	const response = await allowed;
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ items: [{ body: "retained" }] });
	expect((await loggedOut).status).toBe(401);
	expect((await privatePage).status).toBe(401);
	const retainedPage = await publicPage;
	expect(retainedPage.status).toBe(200);
	expect(await retainedPage.text()).toBe("# still public");
	await expect.poll(state).toEqual({ frozen: false, admitted: 0, queued: 0 });
}, 30000);
