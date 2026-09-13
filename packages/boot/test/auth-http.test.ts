import {
	agentHeader,
	assertionHeader,
	instanceHeader,
	requestIdHeader,
	scopesHeader,
	tokenExpiresHeader,
} from "@comms/protocol/headers";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Console, Effect, Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { launcherOutput } from "./fixtures/launcher-diagnostics.ts";
import { authenticator } from "./fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const childState = Schema.Struct({ child: Schema.Struct({ state: Schema.String, attempt: Schema.Int }) });

async function launch(test: TestContext, mode = "normal", blockedAttempts = false) {
	const root = await mkdtemp(join(tmpdir(), "comms-auth-http-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const seed = join(root, "seed");
	await mkdir(seed);
	await copyFile(join(import.meta.dirname, "fixtures/child.ts"), join(seed, "fixture.ts"));
	await writeFile(join(seed, "child.ts"), `import { serve } from "./fixture.ts"; serve(${JSON.stringify(mode)});`);
	if (blockedAttempts) {
		await mkdir(join(root, "data"));
		await writeFile(join(root, "data", "attempts"), "preserve this obstruction");
	}
	const processHandle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: { ...process.env, ENTRY: join(seed, "child.ts"), DATA_DIR: join(root, "data") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let phase = "listener";
	const started = performance.now();
	let beforeCleanup: { exit_code: number | null; signal: NodeJS.Signals | null } | null = null;
	test.onTestFailed(() => {
		Effect.runSync(
			Console.error("Boot auth fixture diagnostic", {
				phase,
				elapsed_ms: Math.round(performance.now() - started),
				before_cleanup: beforeCleanup,
				output: launcherOutput(output),
			}),
		);
	});
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16384);
	};
	processHandle.stdout.on("data", capture);
	processHandle.stderr.on("data", capture);
	test.onTestFinished(async () => {
		beforeCleanup = { exit_code: processHandle.exitCode, signal: processHandle.signalCode };
		if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
		const exited = once(processHandle, "exit");
		processHandle.kill("SIGTERM");
		await Promise.race([exited, delay(4000)]);
		if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
		await exited;
	});
	let url = "";
	await expect
		.poll(
			() => {
				if (processHandle.exitCode !== null) throw new Error(JSON.stringify(launcherOutput(output)));
				url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
				return url;
			},
			{ timeout: 5000 },
		)
		.not.toBe("");
	phase = "setup";
	await expect.poll(async () => (await fetch(`${url}/setup`)).status).toBe(200);
	phase = "ready";
	const code = () => {
		const value = [...output.matchAll(/\/setup is open, code ([A-F0-9]+)/g)].at(-1)?.[1];
		if (!value) throw new Error("Missing setup code");
		return value;
	};
	const post = (path: string, body: unknown, cookie?: string, origin = "https://comms.test") =>
		fetch(`${url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});
	const device = authenticator();
	const setup = async () => {
		const options = await post("/_boot/auth/setup/options", { code: code() });
		expect(options.status).toBe(200);
		const input = Schema.decodeUnknownSync(ceremony)(await options.json());
		const registered = await post("/_boot/auth/setup/verify", {
			id: input.id,
			response: device.registration(input.options.challenge),
		});
		expect(registered.status).toBe(200);
	};
	const login = async (counter = 1) => {
		const options = await post("/_boot/auth/login/options", {});
		expect(options.status).toBe(200);
		const input = Schema.decodeUnknownSync(ceremony)(await options.json());
		const payload = { id: input.id, response: device.assertion(input.options.challenge, counter) };
		const response = await post("/_boot/auth/login/verify", payload);
		expect(response.status).toBe(200);
		const header = response.headers.get("set-cookie");
		const cookie = header?.split(";")[0];
		if (!header || !cookie) throw new Error("Missing session cookie");
		return { response, cookie, header, payload };
	};
	return { url, code, post, setup, login, device, root, output: () => output };
}

it("creates a passkey and a protected session, forwards verified identity, and logs out", async (test) => {
	const app = await launch(test);
	const page = await fetch(`${app.url}/setup`);
	expect(page.headers.get("cache-control")).toBe("no-store");
	expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	expect(await page.text()).not.toContain(app.code());
	expect((await fetch(`${app.url}/_boot/auth/client.js`)).headers.get("content-type")).toContain("text/javascript");
	expect((await fetch(`${app.url}/_boot/status`)).status).toBe(401);
	await app.setup();
	expect((await fetch(`${app.url}/setup`)).status).toBe(404);
	expect((await app.post("/_boot/auth/setup/options", { code: app.code() })).status).toBe(404);
	const session = await app.login();
	for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(session.header).toContain(flag);
	expect(session.header).not.toContain("Domain=");
	expect(session.response.headers.get("cache-control")).toBe("no-store");
	const token = session.cookie.split("=")[1];
	if (!token) throw new Error("Missing token");
	const body = await session.response.text();
	expect(body).not.toContain(token);
	expect(body).not.toContain('"token"');
	expect(session.response.headers.get(tokenExpiresHeader)).toMatch(/^\d+$/);
	expect((await app.post("/_boot/auth/login/verify", session.payload)).status).toBe(401);
	const headers = { cookie: session.cookie };
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(childState)(await (await fetch(`${app.url}/_boot/status`, { headers })).json()).child
					.state,
		)
		.toBe("live");
	const response = await fetch(`${app.url}/echo`, {
		headers: {
			...headers,
			[agentHeader]: "forged",
			[assertionHeader]: "signed-sensitive-proof",
			[instanceHeader]: "forged",
			[scopesHeader]: "admin",
			[requestIdHeader]: "forged",
		},
	});
	const echoed = await response.json();
	expect(echoed).toMatchObject({
		agent: "rahul",
		scopes: "read,write,fs",
		label: "human",
		cookie: null,
		authorization: null,
		assertion: null,
		kind: "human",
	});
	expect(echoed.instance).toBeTruthy();
	expect(echoed.instance).not.toBe("forged");
	expect(echoed.requestId).toMatch(/^[a-f0-9]{32}$/);
	expect(response.headers.get(tokenExpiresHeader)).toBe(session.response.headers.get(tokenExpiresHeader));
	const again = await (await fetch(`${app.url}/echo`, { headers })).json();
	expect(again.instance).toBe(echoed.instance);
	expect(again.requestId).not.toBe(echoed.requestId);
	const cookies = (await fetch(`${app.url}/cookies`, { headers })).headers.getSetCookie();
	expect(cookies.join(";")).not.toContain("__Host-comms_session");
	expect(cookies.join(";")).toContain("app-preference=dark");
	expect(
		(
			await fetch(`${app.url}/api/reload`, { method: "POST", headers: { ...headers, origin: "https://comms.test" } })
		).headers.get(tokenExpiresHeader),
	).toBeTruthy();
	const loggedOut = await app.post("/_boot/auth/logout", {}, session.cookie);
	expect(loggedOut.status).toBe(204);
	expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");
	expect((await fetch(`${app.url}/_boot/status`, { headers })).status).toBe(401);
});

it("redirects unauthenticated page navigations to login and forwards to open setup", async (test) => {
	const app = await launch(test);
	const board = await fetch(`${app.url}/t/design?x=1`, {
		headers: { accept: "text/html,application/xhtml+xml" },
		redirect: "manual",
	});
	expect(board.status).toBe(302);
	expect(board.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent("/t/design?x=1")}`);
	expect(board.headers.get("cache-control")).toBe("no-store");
	const loginPage = await fetch(`${app.url}/auth/login?next=%2Ft%2Fdesign`, { redirect: "manual" });
	expect(loginPage.status).toBe(302);
	expect(loginPage.headers.get("location")).toBe("/onboarding?next=%2Ft%2Fdesign");
	const api = await fetch(`${app.url}/t/design`, { headers: { accept: "application/json" } });
	expect(api.status).toBe(401);
	expect((await api.json()).error.code).toBe("session_invalid");
	await app.setup();
	const loginAfter = await fetch(`${app.url}/auth/login`, { redirect: "manual" });
	expect(loginAfter.status).toBe(200);
	const stillRedirects = await fetch(`${app.url}/`, { headers: { accept: "text/html" }, redirect: "manual" });
	expect(stillRedirects.status).toBe(302);
	expect(stillRedirects.headers.get("location")).toBe("/auth/login?next=%2F");
});

it("guides first setup and only shows the invite step after a human signs in", async (test) => {
	const app = await launch(test, "exit");
	const page = await fetch(`${app.url}/onboarding`);
	expect(page.status).toBe(200);
	expect(page.headers.get("cache-control")).toBe("no-store");
	expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	const html = await page.text();
	expect(html).toContain('data-onboarding="true"');
	expect(html).not.toContain(app.code());
	expect(html).not.toContain('id="copy-invite"');
	expect((await app.post("/_boot/auth/setup/options", { code: "wrong" })).status).toBe(401);
	await app.setup();
	const anonymous = await fetch(`${app.url}/onboarding`, { headers: { accept: "text/html" }, redirect: "manual" });
	expect(anonymous.status).toBe(302);
	expect(anonymous.headers.get("location")).toBe("/auth/login?next=%2Fonboarding");
	const session = await app.login();
	const ready = await fetch(`${app.url}/onboarding`, { headers: { cookie: session.cookie } });
	expect(ready.status).toBe(200);
	const readyHtml = await ready.text();
	expect(readyHtml).toContain('id="copy-invite"');
	expect(readyHtml).not.toContain('id="code"');
	expect((await fetch(`${app.url}/setup`)).status).toBe(404);
	expect((await fetch(`${app.url}/onboarding`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
	expect((await fetch(`${app.url}/onboarding/other`)).status).toBe(401);
	expect((await fetch(`${app.url}/onboarding`, { method: "POST" })).status).toBe(401);
});

it("rejects cross-origin, malformed, oversized, replayed and explicit invalid credentials", async (test) => {
	const app = await launch(test);
	const code = app.code();
	for (let n = 0; n < 3; n++)
		expect(
			(await app.post("/_boot/auth/setup/options", { code: "wrong" }, undefined, "https://evil.test")).status,
		).toBe(403);
	expect(app.code()).toBe(code);
	for (const body of ['{"code":', JSON.stringify({ code: "x".repeat(70_000) }), JSON.stringify({ code: 123 })]) {
		const invalid = await fetch(`${app.url}/_boot/auth/setup/options`, {
			method: "POST",
			headers: { origin: "https://comms.test", "content-type": "application/json" },
			body,
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain(code);
	}
	const started = Schema.decodeUnknownSync(ceremony)(
		await (await app.post("/_boot/auth/setup/options", { code })).json(),
	);
	expect(
		(
			await app.post("/_boot/auth/setup/verify", {
				id: started.id,
				response: app.device.registration(started.options.challenge, "https://evil.test"),
			})
		).status,
	).toBe(401);
	await app.setup();
	const session = await app.login();
	for (const origin of ["https://evil.comms.test", "https://comms.test:8443", "null"])
		expect((await app.post("/echo", {}, session.cookie, origin)).status).toBe(403);
	expect(
		(await fetch(`${app.url}/echo`, { method: "POST", headers: { cookie: session.cookie }, body: "bad" })).status,
	).toBe(403);
	await expect.poll(async () => (await app.post("/echo", { okay: true }, session.cookie)).status).toBe(200);
	for (const headers of [
		{ authorization: "Bearer unsupported" },
		{ authorization: "Bearer unsupported", cookie: session.cookie },
		{ cookie: "__Host-comms_session=invalid" },
		{ cookie: `${session.cookie}; ${session.cookie}` },
	]) {
		expect((await fetch(`${app.url}/echo`, { headers })).status).toBe(401);
		expect((await fetch(`${app.url}/init`, { headers })).status).toBe(401);
	}
	expect((await fetch(`${app.url}/_boot/auth/not-public`)).status).toBe(401);
	expect((await fetch(`${app.url}/setup`, { method: "POST" })).status).toBe(401);
});

it("keeps real setup and login working after all child attempts fail without exposing diagnostics publicly", async (test) => {
	const app = await launch(test, "exit");
	for (const path of ["/", "/_boot/status", "/_boot/generations", "/api/generations", "/api/reload"]) {
		const response = await fetch(`${app.url}${path}`);
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("fixture startup failed");
	}
	for (const path of ["/init", "/init.md"]) {
		const response = await fetch(`${app.url}${path}`);
		expect(response.status).toBe(503);
		const body = await response.text();
		expect(body).not.toContain("fixture startup failed");
		expect(body).not.toContain('"child"');
	}
	expect((await fetch(`${app.url}/health`)).status).toBe(200);
	expect((await fetch(`${app.url}/_boot`)).status).toBe(200);
	const manifest = await fetch(`${app.url}/.well-known/agent.json`);
	expect(manifest.status).toBe(200);
	const recovery = await manifest.json();
	expect(recovery).toHaveProperty("endpoints./api/revert.post.description");
	expect(recovery).not.toHaveProperty("child");
	expect(JSON.stringify(recovery)).not.toContain("fixture startup failed");
	await app.setup();
	const session = await app.login();
	const headers = { cookie: session.cookie };
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(childState)(await (await fetch(`${app.url}/_boot/status`, { headers })).json()).child,
			{ timeout: 5000 },
		)
		.toEqual({ state: "failed", attempt: 3 });
	expect((await fetch(app.url, { headers })).status).toBe(503);
	for (const path of ["/_boot/enrollments", "/_boot/tokens"]) {
		expect((await fetch(`${app.url}${path}`)).status).toBe(401);
		expect(
			(await fetch(`${app.url}${path}`, { headers: { ...headers, authorization: "Bearer invalid" } })).status,
		).toBe(401);
		const listed = await fetch(`${app.url}${path}`, { headers });
		expect(listed.status).toBe(200);
		expect(listed.headers.get("cache-control")).toBe("no-store");
		expect(await listed.json()).toEqual({ items: [] });
	}

	await app.post("/_boot/auth/logout", {}, session.cookie);
	expect((await fetch(`${app.url}/_boot/status`, { headers })).status).toBe(401);
	const relogged = await app.login(2);
	expect((await fetch(`${app.url}/_boot/status`, { headers: { cookie: relogged.cookie } })).status).toBe(200);
});

it("keeps real authentication available when the attempt receipt directory cannot be created", async (test) => {
	const app = await launch(test, "normal", true);
	await app.setup();
	const session = await app.login();
	const headers = { cookie: session.cookie };
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(childState)(await (await fetch(`${app.url}/_boot/status`, { headers })).json()).child
					.state,
			{ timeout: 5000 },
		)
		.toBe("failed");
	for (const path of ["/health", "/_boot", "/auth/login", "/_boot/db/backups"])
		expect((await fetch(`${app.url}${path}`, { headers })).status).toBe(200);
	expect((await fetch(`${app.url}/echo`, { headers })).status).toBe(503);
	const stored = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/store.ts"),
		join(app.root, "data", "boot.db"),
		"SELECT count(*) AS count FROM child_attempts",
	]);
	expect(
		Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Struct({ count: Schema.Int }))))(stored.stdout),
	).toEqual([{ count: 0 }]);
	await app.post("/_boot/auth/logout", {}, session.cookie);
	const relogged = await app.login(2);
	expect((await fetch(`${app.url}/_boot/status`, { headers: { cookie: relogged.cookie } })).status).toBe(200);
});

it("correlates auth request and response diagnostics without recording submitted secrets", async (test) => {
	const app = await launch(test);
	const secret = "private-auth-diagnostic-sentinel";
	const response = await fetch(`${app.url}/_boot/auth/setup/options?private=${secret}`, {
		method: "POST",
		headers: {
			origin: "https://comms.test",
			"content-type": "application/json",
			[requestIdHeader]: secret,
			cookie: secret,
		},
		body: JSON.stringify({ code: secret }),
	});
	expect(response.status).toBe(401);
	const requestId = response.headers.get(requestIdHeader);
	expect(requestId).toMatch(/^[a-f0-9]{32}$/);
	expect(await response.json()).toMatchObject({ error: { code: "setup_code_invalid" } });
	const diagnostics = () =>
		app
			.output()
			.split("\n")
			.filter((line) => line.includes("boot.auth"));
	await expect
		.poll(() =>
			diagnostics().some((line) =>
				line.includes(`stage=response method=POST path=/_boot/auth/setup/options status=401 request_id=${requestId}`),
			),
		)
		.toBe(true);
	expect(
		diagnostics().some((line) =>
			line.includes(`stage=request method=POST path=/_boot/auth/setup/options request_id=${requestId}`),
		),
	).toBe(true);
	expect(diagnostics().join("\n")).not.toContain(secret);
	expect(diagnostics().join("\n")).not.toContain(app.code());
});
