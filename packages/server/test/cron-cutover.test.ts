import { sourcePut } from "./fixtures/source-put.ts";
import { expect, it } from "vitest";
import { Schema } from "effect";
import { cronCutover } from "./fixtures/cron-cutover.ts";

it("keeps public cron jobs scoped to the live process through cutover and a rejected edit", async (test) => {
	const fixture = await cronCutover(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const headers = { cookie, origin: "https://comms.test" };
	const status = async () =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				child: Schema.Struct({ pid: Schema.Int, generation: Schema.Int, state: Schema.String }),
				traffic: Schema.Struct({ frozen: Schema.Boolean }),
			}),
		)(await (await fetch(`${app.url}/_boot/status`, { headers })).json());
	const old = (await status()).child;
	await fixture.wait(`ack-${old.pid}-0`);
	expect(await fixture.markers()).toContain(`job-${old.pid}-0`);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const put = (path: string, body: string) =>
		sourcePut(`${app.url}/api/fs/app/${path}?reload=0`, { method: "PUT", headers, body });
	expect((await put("ext/cron-owner.ts", fixture.extension + "\n// next generation\n")).status).toBe(200);
	const reload = app.post("/api/reload", {}, cookie);
	void reload.catch(() => undefined);
	let candidate = 0;
	try {
		candidate = Number(await fixture.wait("healthy"));
		expect(candidate).toBeGreaterThan(0);
		expect(candidate).not.toBe(old.pid);
		expect((await status()).traffic.frozen).toBe(true);
		await fixture.wait(`closed-${old.pid}`);
		const atHealth = await fixture.markers();
		const rehearsals = atHealth.filter((name) => /^start-\d+-rehearsal$/.test(name));
		expect(rehearsals).toHaveLength(1);
		const rehearsalPid = Number(rehearsals[0]?.split("-")[1]);
		expect(rehearsalPid).toBeGreaterThan(0);
		// Positive health and scope-close handshakes bound these negative assertions.
		expect(atHealth).not.toContain(`open-${rehearsalPid}`);
		expect(atHealth).not.toContain(`open-${candidate}`);
		await fixture.tick(1);
		await fixture.release("healthy");
		expect(Number(await fixture.wait("retired"))).toBe(candidate);
		expect(() => process.kill(old.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		expect(
			await fixture.sql(`SELECT closed FROM child_attempts WHERE generation=${old.generation} AND opened=1`, "boot.db"),
		).toEqual([{ closed: 1 }]);
		expect((await status()).child.pid).toBe(candidate);
		expect(await fixture.sql("SELECT phase FROM cutover", "boot.db")).toEqual([{ phase: "accepted" }]);
		const beforeLive = await fixture.markers();
		expect(beforeLive).not.toContain(`open-${candidate}`);
		expect(beforeLive.filter((name) => name.startsWith("job-"))).toEqual([`job-${old.pid}-0`]);
	} finally {
		await fixture.release("healthy");
		await fixture.release("retired");
		await reload.catch(() => undefined);
	}
	expect(await (await reload).json()).toMatchObject({ status: "live" });
	await fixture.wait(`ack-${candidate}-1`);
	expect(await fixture.markers()).toContain(`job-${candidate}-1`);
	const live = (await status()).child;
	expect(live.pid).toBe(candidate);
	// A broken child entry fails rehearsal, leaving the accepted owner and its scope intact.
	expect((await put("server.ts", 'throw new Error("deliberate bad edit");')).status).toBe(200);
	expect(await (await app.post("/api/reload", {}, cookie)).json()).toMatchObject({ status: "failed" });
	expect((await status()).child).toEqual(live);
	await fixture.tick(2);
	await fixture.wait(`ack-${candidate}-2`);
	const final = await fixture.markers();
	expect(final.filter((name) => name.startsWith("job-")).sort()).toEqual(
		[`job-${old.pid}-0`, `job-${candidate}-1`, `job-${candidate}-2`].sort(),
	);
	for (const name of final.filter((name) => name.startsWith("job-"))) expect(await fixture.read(name)).toBe("ran\n");
	expect(await fixture.read(`open-${old.pid}`)).toBe("opened\n");
	expect(await fixture.read(`open-${candidate}`)).toBe("opened\n");
	expect(final).not.toContain(`closed-${candidate}`);
	expect(await fixture.sql("SELECT generation FROM child_attempts WHERE opened=1 AND closed=0", "boot.db")).toEqual([
		{ generation: live.generation },
	]);
}, 60000);
