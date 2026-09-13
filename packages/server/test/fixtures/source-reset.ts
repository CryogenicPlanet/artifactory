import { assertionHeader } from "@comms/protocol/headers";
import { sourcePut } from "./source-put.ts";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, type TestContext } from "vitest";
import { conversation } from "./conversation.ts";

/** Disposable boot source permits exact process faults without production test switches. */
export async function resetFixture(test: TestContext) {
	const fixture = await conversation(test);
	const boot = join(fixture.root, "packages/boot");
	const seed = await realpath(await mkdtemp(join(tmpdir(), "comms-reset-seed-")));
	test.onTestFinished(() => rm(seed, { recursive: true, force: true }));
	await cp(join(import.meta.dirname, "../../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	await cp(
		join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"),
		join(boot, "test/fixtures/launcher.ts"),
	);
	await symlink(join(import.meta.dirname, "../../../boot/node_modules"), join(boot, "node_modules"));
	await mkdir(join(fixture.root, "packages/server"), { recursive: true });
	await symlink(join(import.meta.dirname, "../../node_modules"), join(fixture.root, "packages/server/node_modules"));
	await cp(join(import.meta.dirname, "../../src"), seed, { recursive: true });
	await writeFile(join(seed, "reset-version.txt"), "configured seed source");
	const launch = () => fixture.launch(join(seed, "server.ts"), join(boot, "test/fixtures/launcher.ts"));
	const initialize = async () => {
		const app = await launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const stage = async (path: string, body: string, reload = false) => {
			const response = await sourcePut(`${app.url}/api/fs/app/${path}?reload=${reload ? 1 : 0}`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body,
			});
			expect(response.status).toBe(200);
			if (reload) expect(await response.json()).toMatchObject({ status: "live" });
		};
		await stage("reset-version.txt", "edited source", true);
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "reset", body: "before reset" }, cookie)).status).toBe(200);
		await mkdir(join(fixture.root, "pages/reset"), { recursive: true });
		await writeFile(join(fixture.root, "pages/reset/index.md"), "# Current page survives reset\n");
		await stage("held.txt", "another session's unpublished repair");
		const staging = await fixture.sql("SELECT * FROM staging", "boot.db");
		const lock = await fixture.sql("SELECT id,holder_family,agent FROM edit_lock", "boot.db");
		const resetCookie = await app.login();
		const request = async () => {
			const proof = await app.signedAssertion("app.reset", {}, resetCookie);
			return fetch(`${app.url}/_boot/reset`, {
				method: "POST",
				headers: {
					cookie: resetCookie,
					origin: "https://comms.test",
					"content-type": "application/json",
					[assertionHeader]: proof,
				},
				body: "{}",
			});
		};
		const assertPreserved = async () => {
			expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(staging);
			expect(await fixture.sql("SELECT id,holder_family,agent FROM edit_lock", "boot.db")).toEqual(lock);
			expect(await fixture.sql("SELECT cutover_in_flight,reset_pin FROM edit_lock", "boot.db")).toEqual([
				{ cutover_in_flight: 0, reset_pin: 0 },
			]);
			expect(await readFile(join(fixture.root, "pages/reset/index.md"), "utf8")).toBe(
				"# Current page survives reset\n",
			);
		};
		return { app, cookie, resetCookie, staging, request, assertPreserved };
	};
	return { ...fixture, boot, seed, launch, initialize };
}
