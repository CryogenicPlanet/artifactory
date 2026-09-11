/* oxlint-disable effecttsgo/node-builtin-import */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { authenticator } from "./fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const listSchema = Schema.Struct({
	items: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, created_at: Schema.Finite })),
	can_delete: Schema.Boolean,
});
it("manages passkeys with the child down and refuses bearer, forged identity, replay and logout during a body", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-passkey-http-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const seed = join(directory, "seed");
	await mkdir(seed);
	await writeFile(join(seed, "child.ts"), 'throw new Error("intentionally unavailable app");');
	const child = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: { ...process.env, ENTRY: join(seed, "child.ts"), DATA_DIR: join(directory, "data") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (bytes: Buffer) => {
		output = (output + bytes.toString()).slice(-16384);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	onTestFinished(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		await Promise.race([exited, delay(4000)]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	let url = "";
	await expect
		.poll(() => {
			url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
			return url;
		})
		.not.toBe("");
	await expect.poll(async () => (await fetch(`${url}/setup`)).status).toBe(200);
	const code = /\/setup is open, code ([A-F0-9]+)/.exec(output)?.[1];
	expect(code).toBeTruthy();
	const first = authenticator(),
		second = authenticator();
	const origin = "https://comms.test";
	const send = (
		path: string,
		input: unknown,
		headers: Readonly<Record<string, string>> = {},
		method: "POST" | "DELETE" = "POST",
	) =>
		fetch(`${url}${path}`, {
			method,
			headers: { "content-type": "application/json", origin, ...headers },
			body: JSON.stringify(input),
		});
	const setup = Schema.decodeUnknownSync(ceremony)(await (await send("/_boot/auth/setup/options", { code })).json());
	expect(
		(await send("/_boot/auth/setup/verify", { id: setup.id, response: first.registration(setup.options.challenge) }))
			.status,
	).toBe(200);
	const login = Schema.decodeUnknownSync(ceremony)(await (await send("/_boot/auth/login/options", {})).json());
	const signedIn = await send("/_boot/auth/login/verify", {
		id: login.id,
		response: first.assertion(login.options.challenge, 1),
	});
	const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error("Missing session cookie");
	const human = { cookie };
	const list = async () => {
		const response = await fetch(`${url}/_boot/auth/passkeys`, { headers: human });
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		return Schema.decodeUnknownSync(listSchema)(await response.json());
	};
	expect((await list()).can_delete).toBe(false);
	for (const headers of [
		{},
		{ "x-comms-auth-kind": "human", "x-comms-instance": "forged" },
		{ authorization: `Bearer ${"a".repeat(43)}` },
		{ ...human, authorization: `Bearer ${"a".repeat(43)}` },
	]) {
		expect((await fetch(`${url}/_boot/auth/passkeys`, { headers })).status).toBe(401);
		expect((await send("/_boot/auth/passkeys/options", { label: "Hardware key" }, headers)).status).toBe(401);
		expect(
			(await send("/_boot/auth/challenge", { action: "passkey.delete", params: { id: first.id } }, headers)).status,
		).toBe(401);
	}
	expect(
		(await send("/_boot/auth/passkeys/options", { label: "Hardware key" }, { ...human, origin: "https://evil.test" }))
			.status,
	).toBe(403);
	expect((await send("/_boot/auth/passkeys/options", { label: "line\nbreak" }, human)).status).toBe(400);
	expect((await send("/_boot/auth/passkeys/options", { label: "valid", extra: true }, human)).status).toBe(400);
	const startResponse = await send("/_boot/auth/passkeys/options", { label: "Hardware key" }, human);
	expect(startResponse.status).toBe(200);
	const start = Schema.decodeUnknownSync(ceremony)(await startResponse.json());
	const registration = second.registration(start.options.challenge);
	const add = { id: start.id, label: "Hardware key", response: registration };
	let counter = 1;
	const proof = async (action: string, params: unknown) => {
		const response = await send("/_boot/auth/challenge", { action, params }, human);
		expect(response.status).toBe(200);
		const input = Schema.decodeUnknownSync(ceremony)(await response.json());
		return Buffer.from(
			JSON.stringify({ id: input.id, response: first.assertion(input.options.challenge, ++counter) }),
		).toString("base64url");
	};
	const addProof = await proof("passkey.add", { registration: start.id, label: add.label, response: registration });
	const signed = { ...human, "x-comms-assertion": addProof };
	expect((await send("/_boot/auth/passkeys/verify", add, human)).status).toBe(401);
	expect(
		(
			await send(
				"/_boot/auth/passkeys/verify",
				{ ...add, response: authenticator().registration(start.options.challenge) },
				signed,
			)
		).status,
	).toBe(401);
	expect(
		(
			await send("/_boot/auth/passkeys/verify", add, {
				"x-comms-assertion": addProof,
				"x-boot-secret": "forged",
				"x-comms-auth-kind": "human",
			})
		).status,
	).not.toBe(200);
	const added = await send("/_boot/auth/passkeys/verify", add, signed);
	expect(added.status).toBe(200);
	expect(added.headers.get("cache-control")).toBe("no-store");
	expect(added.headers.get("set-cookie")).toBeNull();
	expect((await send("/_boot/auth/passkeys/verify", add, signed)).status).toBe(401);
	const keys = await list();
	expect(keys.can_delete).toBe(true);
	expect(keys.items).toHaveLength(2);
	expect(keys.items.find((row) => row.id === second.id)?.label).toBe("Hardware key");
	const removeProof = await proof("passkey.delete", { id: second.id });
	const deleteHeaders = { ...human, "x-comms-assertion": removeProof };
	expect((await send(`/_boot/auth/passkeys/${first.id}`, {}, deleteHeaders, "DELETE")).status).toBe(401);
	// Send half the body, revoke its session, then allow the signed request to finish.
	let finishBody: (() => void) | undefined;
	const held = new Promise<number>((resolve, reject) => {
		const request = httpRequest(
			`${url}/_boot/auth/passkeys/${second.id}`,
			{
				method: "DELETE",
				headers: { ...deleteHeaders, origin, "content-type": "application/json", "content-length": "2" },
			},
			(response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
			},
		);
		request.on("error", reject);
		request.write("{");
		finishBody = () => request.end("}");
	});
	await delay(60);
	expect((await send("/_boot/auth/logout", {}, human)).status).toBe(204);
	finishBody?.();
	expect(await held).toBe(401);
	const secondLogin = Schema.decodeUnknownSync(ceremony)(await (await send("/_boot/auth/login/options", {})).json());
	const remaining = await send("/_boot/auth/login/verify", {
		id: secondLogin.id,
		response: second.assertion(secondLogin.options.challenge, 1),
	});
	expect(remaining.status).toBe(200);
	const newCookie = remaining.headers.get("set-cookie")?.split(";")[0];
	if (!newCookie) throw new Error("Missing new session cookie");
	for (const [id, nextCounter, status] of [
		[first.id, 2, 200],
		[second.id, 3, 409],
	] satisfies ReadonlyArray<readonly [string, number, number]>) {
		const response = await send(
			"/_boot/auth/challenge",
			{ action: "passkey.delete", params: { id } },
			{ cookie: newCookie },
		);
		expect(response.status).toBe(200);
		const input = Schema.decodeUnknownSync(ceremony)(await response.json());
		const signedDelete = Buffer.from(
			JSON.stringify({ id: input.id, response: second.assertion(input.options.challenge, nextCounter) }),
		).toString("base64url");
		const deleted = await send(
			`/_boot/auth/passkeys/${id}`,
			{},
			{ cookie: newCookie, "x-comms-assertion": signedDelete },
			"DELETE",
		);
		expect(deleted.status).toBe(status);
		expect(deleted.headers.get("set-cookie")).toBeNull();
	}
	expect((await fetch(`${url}/setup`)).status).toBe(404);
}, 20_000);
