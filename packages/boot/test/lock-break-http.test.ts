import { sourcePut } from "./fixtures/source-put.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { authenticator } from "./fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const lockResult = Schema.Struct({ lock: Schema.Struct({ id: Schema.String, holder_family: Schema.String }) });

async function launch(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-lock-break-http-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const seed = join(root, "seed");
	await mkdir(seed);
	await copyFile(join(import.meta.dirname, "fixtures/child.ts"), join(seed, "fixture.ts"));
	await writeFile(join(seed, "child.ts"), 'import { serve } from "./fixture.ts"; serve("normal");');
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
	test.onTestFinished(async () => {
		if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
		const exited = once(processHandle, "exit");
		processHandle.kill("SIGTERM");
		await Promise.race([exited, delay(4000)]);
		if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
		await exited;
	});
	let url = "";
	await expect
		.poll(() => {
			if (processHandle.exitCode !== null) throw new Error(output);
			url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
			return url;
		})
		.not.toBe("");
	await expect.poll(async () => (await fetch(`${url}/setup`)).status).toBe(200);
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
		return { cookie };
	};
	return { url, post, setup, login, device };
}

it("requires a fresh human proof bound to the observed lock and preserves a replacement on replay", async (test) => {
	const app = await launch(test);
	await app.setup();
	const session = await app.login();
	const human = { cookie: session.cookie, origin: "https://comms.test", "content-type": "application/json" };
	let counter = 1;
	const proof = async (action: string, params: unknown) => {
		const response = await app.post("/_boot/auth/challenge", { action, params }, session.cookie);
		expect(response.status).toBe(200);
		const input = Schema.decodeUnknownSync(ceremony)(await response.json());
		return Buffer.from(
			JSON.stringify({
				id: input.id,
				response: app.device.assertion(input.options.challenge, ++counter),
			}),
		).toString("base64url");
	};
	const enrolled = await app.post("/auth/enroll", { name: "codex", kind: "codex", host: "lock-owner" });
	expect(enrolled.status).toBe(200);
	const enrollment = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, device_secret: Schema.String }))(
		await enrolled.json(),
	);
	const decision = { id: enrollment.id, decision: "approve", scopes: ["read", "write", "fs"], long_lived: false };
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { ...human, "x-chirp-assertion": await proof("enrollment.decide", decision) },
				body: JSON.stringify({ decision: decision.decision, scopes: decision.scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	const collected = await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret });
	expect(collected.status).toBe(200);
	const pair = Schema.decodeUnknownSync(Schema.Struct({ access: Schema.String }))(await collected.json());
	const bearer = { authorization: `Bearer ${pair.access}`, "content-type": "application/json" };
	await expect.poll(async () => (await fetch(app.url, { headers: bearer })).status).toBe(200);
	const acquire = async () => {
		const response = await fetch(`${app.url}/api/lock`, {
			method: "POST",
			headers: bearer,
			body: JSON.stringify({ note: "agent edits" }),
		});
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(lockResult)(await response.json()).lock;
	};
	const inspect = async () =>
		Schema.decodeUnknownSync(lockResult)(await (await fetch(`${app.url}/api/lock`, { headers: bearer })).json()).lock;
	const lock = await acquire();
	const staged = `${app.url}/api/fs/app/pending.txt`;
	expect(
		(await sourcePut(`${staged}?reload=0`, { method: "PUT", headers: bearer, body: "unpublished edits" }, fetch))
			.status,
	).toBe(200);
	const breakLock = (id: string, headers: Readonly<Record<string, string>>, path = "/_boot/lock?break=1") =>
		fetch(`${app.url}${path}`, { method: "DELETE", headers, body: JSON.stringify({ id }) });
	const challengeBody = JSON.stringify({ action: "lock.break", params: { id: lock.id } });
	for (const [headers, status] of [
		[{ origin: "https://comms.test", "content-type": "application/json" }, 401],
		[{ cookie: session.cookie, "content-type": "application/json" }, 403],
		[{ ...human, origin: "https://evil.test" }, 403],
		[{ ...bearer, origin: "https://comms.test" }, 401],
	] satisfies ReadonlyArray<readonly [Readonly<Record<string, string>>, number]>) {
		expect(
			(await fetch(`${app.url}/_boot/auth/challenge`, { method: "POST", headers, body: challengeBody })).status,
		).toBe(status);
		expect((await breakLock(lock.id, headers)).status).toBe(status);
	}
	expect((await breakLock(lock.id, human)).status).toBe(401);
	const signed = await proof("lock.break", { id: lock.id });
	const signedHuman = { ...human, "x-chirp-assertion": signed };
	for (const headers of [
		{ cookie: session.cookie, "content-type": "application/json", "x-chirp-assertion": signed },
		{ ...signedHuman, origin: "https://evil.test" },
	])
		expect((await breakLock(lock.id, headers)).status).toBe(403);
	// A valid proof cannot turn an agent credential into a human session, even with a human cookie present.
	for (const headers of [
		{ ...bearer, origin: human.origin },
		{ ...human, ...bearer },
	]) {
		expect((await breakLock(lock.id, { ...headers, "x-chirp-assertion": signed })).status).toBe(401);
	}
	expect(
		(
			await breakLock(lock.id, {
				...human,
				"x-chirp-assertion": await proof("token.revoke", { family: lock.holder_family }),
			})
		).status,
	).toBe(401);
	expect((await breakLock("00000000-0000-4000-8000-000000000000", signedHuman)).status).toBe(401);
	expect(await inspect()).toEqual(lock);
	expect(await (await fetch(staged, { headers: bearer })).text()).toBe("unpublished edits");
	const broken = await breakLock(lock.id, signedHuman, "/api/lock?break=1");
	expect(broken.status).toBe(200);
	expect(broken.headers.get("cache-control")).toBe("no-store");
	expect((await fetch(staged, { headers: bearer })).status).toBe(404);
	const replacement = await acquire();
	expect(replacement.id).not.toBe(lock.id);
	for (const id of [lock.id, replacement.id]) expect((await breakLock(id, signedHuman)).status).toBe(401);
	expect(await inspect()).toEqual(replacement);
	// A newly signed but stale observation must not break a later acquisition either.
	const stale = await proof("lock.break", { id: lock.id });
	expect((await breakLock(lock.id, { ...human, "x-chirp-assertion": stale })).status).toBe(423);
	expect(await inspect()).toEqual(replacement);
});
