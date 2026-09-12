import { Redacted } from "effect";
import { render } from "@comms/storage/store";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launch } from "./fixtures/proxy-launch.ts";

function post(url: string, path: string, headers: Record<string, string> = {}) {
	return new Promise<number>((resolve, reject) => {
		const outgoing = request(
			url,
			{ path, method: "POST", headers: { ...headers, "content-type": "application/json" } },
			(response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
			},
		);
		outgoing.on("error", reject);
		outgoing.end(JSON.stringify({ action: "frozen" }));
	});
}

it("never proxies public or authenticated kernel namespace aliases to a live child", async (test) => {
	const app = await launch(test, "normal", true);
	await expect.poll(async () => (await app.state()).state, { timeout: 5000 }).toBe("live");
	for (const path of [
		"/_kernel",
		"//_kernel/control",
		"///_kernel/control",
		"/_kernel/",
		"/_kernel/control",
		"/_kernel/control?x=1",
		"/%5fkernel/control",
		"/_%6bernel/control",
		"/_kernel%2fcontrol",
		"/_kernel%5ccontrol",
		"/_kernel//control",
		"/p/../_kernel/control",
		"/init/../%5fkernel/control",
		"/p/%2e%2e/_kernel/control",
		"/%2f_kernel/control",
	]) {
		for (const headers of [
			{},
			{ cookie: app.cookie, origin: "https://comms.test" },
			{ authorization: "Bearer invalid", "x-comms-agent": "rahul" },
		]) {
			expect(await post(app.url, path, headers), path).toBe(403);
		}
	}
	const write = await app.fetch(`${app.url}/api/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "guard", body: "Still writable after rejected controls" }),
	});
	expect(write.status).toBe(200);
	expect((await app.fetch(`${app.url}/api/messages?since=0`)).status).toBe(200);
	expect((await app.state()).state).toBe("live");
});

it("rejects caller metadata even with the correct secret on direct child control", async (test) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-control-guard-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const secret = "test-only-direct-control-secret";
	const child = spawn("bun", [join(import.meta.dirname, "../../server/src/server.ts")], {
		env: {
			...process.env,
			PORT: "0",
			BOOT_SECRET: secret,
			STATE: "candidate",
			WRITER_EPOCH: "guard-test",
			GENERATION: "1",
			APP_STORE: Redacted.value(render({ _tag: "file", filename: join(directory, "app.db") })),
			APP_DATABASE: join(directory, "app.db"),
			PAGES_DIRECTORY: directory,
			BOOT_URL: "http://127.0.0.1:1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	test.onTestFinished(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	});
	await expect.poll(() => /COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1]).toBeTruthy();
	const url = `http://127.0.0.1:${/COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1]}`;
	for (const name of [
		"x-comms-request-id",
		"x-comms-agent",
		"x-comms-auth-kind",
		"x-comms-instance",
		"x-comms-public-page",
	]) {
		expect(await post(url, "/_kernel/control", { "x-boot-secret": secret, [name]: "injected" })).toBe(403);
	}
	const trusted = await fetch(`${url}/_kernel/control`, {
		method: "POST",
		headers: { "x-boot-secret": secret, "content-type": "application/json" },
		body: JSON.stringify({ action: "frozen" }),
	});
	expect(trusted.status).toBe(200);
	expect(await trusted.json()).toEqual({ state: "frozen", mutations: 0, requests: 0 });
});
