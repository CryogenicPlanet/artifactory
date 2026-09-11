import { expect, it } from "vitest";
import { launch } from "./fixtures/proxy-launch.ts";

it("releases completed and cancelled request leases before boot shutdown", async (test) => {
	const app = await launch(test);
	await expect.poll(async () => (await app.state()).state, { timeout: 5000 }).toBe("live");
	const traffic = async () => (await (await app.fetch(`${app.url}/_boot/status`)).json()).traffic;
	const completed = await app.fetch(`${app.url}/echo`, { method: "POST", body: "completed" });
	expect(completed.status).toBe(200);
	await completed.text();
	await expect.poll(traffic).toMatchObject({ admitted: 0, queued: 0 });
	const held = await app.fetch(`${app.url}/hold-stream`, { method: "POST", body: "held" });
	const reader = held.body?.getReader();
	if (!reader) throw new Error("Expected held response body");
	expect(new TextDecoder().decode((await reader.read()).value)).toBe("open\n");
	expect(await traffic()).toMatchObject({ admitted: 1, queued: 0 });
	await reader.cancel();
	await expect.poll(traffic).toMatchObject({ admitted: 0, queued: 0 });
	await expect.poll(async () => (await app.fetch(`${app.url}/cancelled`)).text()).toBe("1");
});
