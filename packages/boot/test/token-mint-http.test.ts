import { agentHeader, assertionHeader, authKindHeader } from "@comms/protocol/headers";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { TokenPair } from "../src/refresh-schema.ts";
import type { MintToken } from "../src/token-mint-schema.ts";
import { authenticator } from "./fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const input: MintToken = { agent: "codex", label: "job-17", scopes: ["read", "write"], long_lived: false };

async function fixture(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-token-mint-http-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const seed = join(root, "seed");
	await mkdir(seed);
	await copyFile(join(import.meta.dirname, "fixtures/child.ts"), join(seed, "fixture.ts"));
	await writeFile(join(seed, "child.ts"), 'import { serve } from "./fixture.ts"; serve("normal");');
	const start = async () => {
		const processHandle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
			env: { ...process.env, ENTRY: join(seed, "child.ts"), DATA_DIR: join(root, "data") },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16384);
		};
		processHandle.stdout.on("data", capture);
		processHandle.stderr.on("data", capture);
		const stop = async () => {
			if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
			const exited = once(processHandle, "exit");
			processHandle.kill("SIGTERM");
			await Promise.race([exited, delay(4000)]);
			if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
			await exited;
		};
		test.onTestFinished(stop);
		let url = "";
		await expect
			.poll(
				() => {
					if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error(output);
					url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
					return url;
				},
				{ timeout: 5000 },
			)
			.not.toBe("");
		// The listener becomes live before the authentication store is ready, including on restart.
		await expect.poll(async () => (await fetch(`${url}/auth/login`)).status).toBe(200);
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

		const setup = async () => {
			await expect.poll(async () => (await fetch(`${url}/setup`)).status).toBe(200);
			await expect.poll(() => output).toMatch(/\/setup is open, code [A-F0-9]+/);
			const options = await post("/_boot/auth/setup/options", { code: code() });
			expect(options.status).toBe(200);
			const input = Schema.decodeUnknownSync(ceremony)(await options.json());
			const registered = await post("/_boot/auth/setup/verify", {
				id: input.id,
				response: device.registration(input.options.challenge),
			});
			expect(registered.status).toBe(200);
		};
		const login = async () => {
			const options = await post("/_boot/auth/login/options", {});
			expect(options.status).toBe(200);
			const input = Schema.decodeUnknownSync(ceremony)(await options.json());
			const payload = { id: input.id, response: device.assertion(input.options.challenge, ++counter) };
			const response = await post("/_boot/auth/login/verify", payload);
			expect(response.status).toBe(200);
			const header = response.headers.get("set-cookie");
			const cookie = header?.split(";")[0];
			if (!header || !cookie) throw new Error("Missing session cookie");
			return { cookie };
		};
		return { url, post, setup, login, stop };
	};
	const device = authenticator();
	let counter = 0;
	const proof = async (
		app: Awaited<ReturnType<typeof start>>,
		cookie: string,
		action: string,
		params: unknown,
		origin = "https://comms.test",
		rpId = "comms.test",
		uv = true,
	) => {
		const response = await app.post("/_boot/auth/challenge", { action, params }, cookie);
		expect(response.status).toBe(200);
		const challenge = Schema.decodeUnknownSync(ceremony)(await response.json());
		return Buffer.from(
			JSON.stringify({
				id: challenge.id,
				response: device.assertion(challenge.options.challenge, ++counter, origin, rpId, uv),
			}),
		).toString("base64url");
	};
	const sql = async (statement: string) =>
		Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
			(
				await promisify(execFile)("bun", [
					join(import.meta.dirname, "fixtures/store.ts"),
					join(root, "data/boot.db"),
					statement,
				])
			).stdout,
		);
	return { start, proof, sql };
}

const human = (cookie: string) => ({ cookie, origin: "https://comms.test", "content-type": "application/json" });
const mint = (url: string, headers: Readonly<Record<string, string>>, body: unknown = input, path = "/_boot/tokens") =>
	fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

it("binds token mint to a human session, exact Origin, fresh verified passkey, and canonical request", async (test) => {
	const env = await fixture(test),
		app = await env.start();
	await app.setup();
	const { cookie } = await app.login();
	const headers = human(cookie);
	for (const [supplied, status] of [
		[{ origin: headers.origin, "content-type": "application/json" }, 401],
		[{ cookie, "content-type": "application/json" }, 403],
		[{ ...headers, origin: "https://evil.test" }, 403],
		[{ ...headers, [authKindHeader]: "human", [agentHeader]: "rahul", cookie: "" }, 401],
	] satisfies ReadonlyArray<readonly [Readonly<Record<string, string>>, number]>) {
		expect((await mint(app.url, supplied)).status).toBe(status);
		expect(
			(
				await fetch(`${app.url}/_boot/auth/challenge`, {
					method: "POST",
					headers: supplied,
					body: JSON.stringify({ action: "token.mint", params: input }),
				})
			).status,
		).toBe(status);
	}
	expect((await mint(app.url, headers)).status).toBe(401);
	const otherAction = await env.proof(app, cookie, "token.revoke", { family: `f_${"a".repeat(43)}` });
	expect((await mint(app.url, { ...headers, [assertionHeader]: otherAction })).status).toBe(401);
	for (const [origin, rpId, uv] of [
		["https://evil.test", "comms.test", true],
		["https://comms.test", "evil.test", true],
		["https://comms.test", "comms.test", false],
	] as const) {
		const bad = await env.proof(app, cookie, "token.mint", input, origin, rpId, uv);
		expect((await mint(app.url, { ...headers, [assertionHeader]: bad })).status).toBe(401);
	}
	const signed = await env.proof(app, cookie, "token.mint", input);
	const authorized = { ...headers, [assertionHeader]: signed };
	for (const label of ["你好", "job\n17", "job 17"]) {
		const invalid = { ...input, label };
		expect((await app.post("/_boot/auth/challenge", { action: "token.mint", params: invalid }, cookie)).status).toBe(
			400,
		);
		expect((await mint(app.url, authorized, invalid)).status).toBe(400);
	}
	for (const changed of [
		{ ...input, agent: "other" },
		{ ...input, label: "other" },
		{ ...input, scopes: ["fs"] },
		{ ...input, long_lived: true },
	])
		expect((await mint(app.url, authorized, changed)).status).toBe(401);
	const accepted = await mint(app.url, authorized, { ...input, scopes: ["write", "read"] }, "/api/tokens");
	expect(accepted.status).toBe(200);
	expect(accepted.headers.get("cache-control")).toBe("no-store");
	const pair = Schema.decodeUnknownSync(TokenPair)(await accepted.json());
	expect(pair).toMatchObject({ agent: input.agent, label: input.label, scopes: input.scopes });
	expect(await (await mint(app.url, authorized)).json()).toEqual(pair);
	for (const supplied of [
		{ authorization: `Bearer ${pair.access}`, origin: headers.origin },
		{ ...headers, authorization: `Bearer ${pair.access}` },
	]) {
		expect(
			(await mint(app.url, { ...supplied, "content-type": "application/json", [assertionHeader]: signed })).status,
		).toBe(401);
		expect(
			(
				await fetch(`${app.url}/_boot/auth/challenge`, {
					method: "POST",
					headers: { ...supplied, "content-type": "application/json" },
					body: JSON.stringify({ action: "token.mint", params: input }),
				})
			).status,
		).toBe(401);
	}
	expect(await env.sql("SELECT count(*) AS count FROM tokens")).toEqual([{ count: 2 }]);
}, 15000);

it("replays one exact signed mint concurrently and across restart, refreshes direct grants, and refuses revoked replay", async (test) => {
	const env = await fixture(test);
	let app = await env.start();
	await app.setup();
	const { cookie } = await app.login();
	const secondSession = await app.login();
	expect(secondSession.cookie).not.toBe(cookie);
	for (const long_lived of [false, true]) {
		const body = { ...input, agent: "7codex", long_lived },
			key = `mint-${long_lived}`;
		const signed = await env.proof(app, cookie, "token.mint", { ...body, idempotency_key: key });
		const headers = { ...human(cookie), "idempotency-key": key, [assertionHeader]: signed };
		const responses = await Promise.all(Array.from({ length: 4 }, () => mint(app.url, headers, body)));
		for (const response of responses) expect(response.status).toBe(200);
		const pairs = await Promise.all(
			responses.map(async (response) => Schema.decodeUnknownSync(TokenPair)(await response.json())),
		);
		const pair = pairs[0];
		if (!pair) throw new Error("Missing mint response");
		for (const result of pairs) expect(result).toEqual(pair);
		expect(pair.agent).toBe("7codex");
		expect((await mint(app.url, { ...headers, cookie: secondSession.cookie }, body)).status).toBe(401);
		expect(pair.refresh_expires_at - pair.expires_at).toBe((long_lived ? 83 : 29) * 86400000);
		expect((await mint(app.url, headers, { ...body, label: "changed" })).status).toBe(409);
		const replacement = await env.proof(app, cookie, "token.mint", { ...body, idempotency_key: key });
		expect((await mint(app.url, { ...headers, [assertionHeader]: replacement }, body)).status).toBe(401);
		expect((await mint(app.url, { ...headers, "idempotency-key": `${key}-changed` }, body)).status).toBe(401);
		await app.stop();
		app = await env.start();
		const replay = await mint(app.url, headers, body, "/api/tokens");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(pair);
		const rotated = await app.post("/auth/refresh", { refresh: pair.refresh });
		expect(rotated.status).toBe(200);
		const next = Schema.decodeUnknownSync(TokenPair)(await rotated.json());
		expect(next.family).toBe(pair.family);
		expect(next.refresh).not.toBe(pair.refresh);
		expect(next.refresh_expires_at - next.expires_at).toBe((long_lived ? 83 : 29) * 86400000);
		const revokeProof = await env.proof(app, cookie, "token.revoke", { family: pair.family });
		const revoked = await fetch(`${app.url}/_boot/tokens/${pair.family}/revoke`, {
			method: "POST",
			headers: { ...human(cookie), [assertionHeader]: revokeProof },
			body: "{}",
		});
		expect(revoked.status).toBe(200);
		expect((await mint(app.url, headers, body)).status).toBe(401);
		expect((await app.post("/auth/refresh", { refresh: next.refresh })).status).toBe(401);
	}
	expect(await env.sql("SELECT count(*) AS count FROM enrollments")).toEqual([{ count: 0 }]);
	expect(await env.sql("SELECT count(DISTINCT family) AS count FROM tokens")).toEqual([{ count: 2 }]);
	expect(
		await env.sql("SELECT count(*) AS count FROM events WHERE json_extract(event,'$.type')='token.minted'"),
	).toEqual([{ count: 2 }]);
}, 25000);

for (const mode of ["logout", "expiry"])
	it(`refuses a held mint body after session ${mode}`, async (test) => {
		const env = await fixture(test),
			app = await env.start();
		await app.setup();
		const { cookie } = await app.login();
		const proof = await env.proof(app, cookie, "token.mint", input);
		const body = JSON.stringify(input);
		const pending = request(`${app.url}/_boot/tokens`, {
			method: "POST",
			headers: { ...human(cookie), [assertionHeader]: proof, "content-length": String(Buffer.byteLength(body)) },
		});
		test.onTestFinished(() => {
			pending.destroy();
		});
		const result = new Promise<number | undefined>((resolve, reject) => {
			pending.on("response", (response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode));
			});
			pending.on("error", reject);
		});
		pending.write(body.slice(0, 1));
		await delay(100);
		if (mode === "logout") expect((await app.post("/_boot/auth/logout", {}, cookie)).status).toBe(204);
		else await env.sql("UPDATE sessions SET expires_at=0");
		pending.end(body.slice(1));
		expect(await result).toBe(401);
		expect(await env.sql("SELECT count(*) AS count FROM tokens")).toEqual([{ count: 0 }]);
		expect(await env.sql("SELECT count(*) AS count FROM mint_receipts")).toEqual([{ count: 0 }]);
		expect(
			await env.sql("SELECT count(*) AS count FROM events WHERE json_extract(event,'$.type')='token.minted'"),
		).toEqual([{ count: 0 }]);
	}, 15000);
