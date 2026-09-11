import { once } from "node:events";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { launch } from "./fixtures/proxy-launch.ts";

function rawRequest(url: string, method = "GET", headers: Record<string, string> = {}, body = "") {
	return new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
		const outgoing = request(url, { method, headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
			response.on("error", reject);
		});
		outgoing.on("error", reject);
		outgoing.end(body);
	});
}

describe("real Bun boot proxy", () => {
	it("forwards upload chunks before the request finishes", async (test) => {
		const app = await launch(test);
		await expect.poll(async () => (await app.state()).state).toBe("live");
		const upload = request(`${app.url}/upload`, {
			method: "POST",
			headers: { cookie: app.cookie, origin: "https://comms.test" },
		});
		const completed = new Promise<string>((resolve, reject) => {
			upload.on("error", reject);
			upload.on("response", (response) => {
				let body = "";
				response.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				response.on("end", () => resolve(body));
				response.on("error", reject);
			});
		});
		try {
			upload.write("first");
			await expect.poll(async () => (await app.fetch(`${app.url}/received`)).text()).toBe("5");
			upload.end("second");
			expect(await completed).toBe("11");
		} finally {
			upload.destroy();
			await completed.catch(() => undefined);
		}
	});

	it("reports child exit without waiting for inherited stderr to close", async (test) => {
		const app = await launch(test);
		await expect.poll(async () => (await app.state()).state).toBe("live");
		await app.fetch(`${app.url}/crash-inherited`);
		await expect.poll(async () => (await app.state()).state, { timeout: 500 }).toBe("failed");
		expect((await app.fetch(`${app.url}/health`)).status).toBe(200);
	});

	it("forwards POST bytes/query and strips credentials, identity and hop headers", async (test) => {
		const app = await launch(test);
		await expect.poll(async () => (await app.state()).state).toBe("live");
		const response = await rawRequest(
			`${app.url}/echo?q=a%2Fb`,
			"POST",
			{
				cookie: `${app.cookie}; other=private`,
				origin: "https://comms.test",
				"x-comms-agent": "forged",
				"x-comms-assertion": "fresh-proof",
				"x-forwarded-for": "remote",
				"x-boot-secret": "forged",
				connection: "x-hop",
				"x-hop": "remove",
				"content-type": "text/plain",
			},
			"hello 🌎",
		);
		expect(JSON.parse(response.body.toString())).toEqual({
			method: "POST",
			path: "/echo",
			search: "?q=a%2Fb",
			body: "hello 🌎",
			authorization: null,
			cookie: null,
			assertion: null,
			kind: "human",
			expires: expect.stringMatching(/^[0-9]+$/),
			agent: "rahul",
			instance: app.id,
			scopes: "read,write,fs",
			label: "human",
			requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
			forwarded: null,
			hop: null,
			contentType: "text/plain",
			inheritedSecret: null,
		});
		const root = await app.fetch(app.url);
		expect(root.headers.get("x-hop-response")).toBeNull();
		expect(root.headers.get("x-boot-secret")).toBeNull();
		expect(root.headers.get("content-type")).toBeNull();
		expect(root.headers.get("set-cookie")).toBeNull();
		for (const contentType of ["application/json", "multipart/form-data; boundary=comms-test"]) {
			const reply = await rawRequest(
				`${app.url}/echo`,
				"POST",
				{ "content-type": contentType, cookie: app.cookie, origin: "https://comms.test" },
				"unchanged-body",
			);
			expect(JSON.parse(reply.body.toString())).toMatchObject({ contentType, body: "unchanged-body" });
		}
		expect(
			(
				await app.fetch(`${app.url}/api/reload`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(423);
	});

	it("streams responses, preserves compression and redirects, and forwards empty bodies", async (test) => {
		const app = await launch(test);
		await expect.poll(async () => (await app.state()).state).toBe("live");
		const stream = await app.fetch(`${app.url}/stream`);
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("Expected stream body");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("second\n");
		expect((await reader.read()).done).toBe(true);
		expect(await (await app.fetch(`${app.url}/gzip`)).text()).toBe("compressed-body");
		const compressed = await rawRequest(`${app.url}/gzip`, "GET", { cookie: app.cookie });
		expect(compressed.headers["content-encoding"]).toBe("gzip");
		expect(gunzipSync(compressed.body).toString()).toBe("compressed-body");
		const redirect = await app.fetch(`${app.url}/redirect`, { redirect: "manual" });
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("location")).toBe("/echo");
		expect((await app.fetch(`${app.url}/empty`)).status).toBe(204);
		expect(await (await app.fetch(app.url, { method: "HEAD" })).text()).toBe("");
	});

	it("keeps recovery routes alive when a healthy child crashes", async (test) => {
		const app = await launch(test);
		await expect.poll(async () => (await app.state()).state).toBe("live");
		await app.fetch(`${app.url}/crash`);
		await expect.poll(async () => (await app.state()).state).toBe("failed");
		expect((await app.fetch(`${app.url}/health`)).status).toBe(200);
		expect(await (await app.fetch(`${app.url}/_boot`)).text()).toContain("restart the launcher");
		expect((await app.fetch(app.url)).status).toBe(503);
		expect(app.processHandle.exitCode).toBeNull();
	});

	it.for(["exit", "silent", "unhealthy"])(
		"does not route a %s child and preserves diagnostics",
		{ timeout: 12000 },
		async (mode, test) => {
			const app = await launch(test, mode);
			expect((await app.fetch(app.url)).status).toBe(503);
			await expect.poll(async () => (await app.state()).state, { timeout: 9000 }).toBe("failed");
			expect((await app.fetch(`${app.url}/health`)).status).toBe(200);
			if (mode === "exit") expect((await app.state()).stderr).toContain("fixture startup failed");
		},
	);

	it("bounds stderr capture without blocking the child", async (test) => {
		const app = await launch(test, "stderr");
		await expect.poll(async () => (await app.state()).state).toBe("live");
		const state = await app.state();
		if (typeof state.stderr !== "string") throw new Error("Expected stderr text");
		expect(state.stderr.length).toBeLessThanOrEqual(8192);
		expect(state.stderr).toContain("stderr-tail");
	});

	it("launches the actual server separately and guards direct child requests", async (test) => {
		const app = await launch(test, "normal", true);
		await expect.poll(async () => (await app.state()).state).toBe("live");
		const state = await app.state();
		if (typeof state.port !== "number" || typeof state.pid !== "number") throw new Error("Expected child address");
		const messages = await app.fetch(`${app.url}/api/messages?since=0`);
		expect(messages.status).toBe(200);
		expect(await messages.json()).toMatchObject({ items: [] });
		expect((await fetch(`http://127.0.0.1:${state.port}/health`)).status).toBe(403);
		expect((await fetch(`http://127.0.0.1:${state.port}/`, { headers: { "x-boot-secret": "wrong" } })).status).toBe(
			403,
		);
		const stopped = once(app.processHandle, "exit");
		app.processHandle.kill("SIGTERM");
		await stopped;
		await expect
			.poll(() => {
				try {
					if (typeof state.pid !== "number") throw new Error("Expected pid");
					process.kill(state.pid, 0);
					return false;
				} catch {
					return true;
				}
			})
			.toBe(true);
	});
});
