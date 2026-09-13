/* oxlint-disable effecttsgo/node-builtin-import */
import { assertionHeader } from "@comms/protocol/headers";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { authenticator } from "./fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const issued = Schema.Struct({ code: Schema.String, origin: Schema.NullOr(Schema.String), expires_at: Schema.Finite });
const failure = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const primary = { origin: "https://comms.test", rpId: "comms.test" };
const other = { origin: "https://other.test", rpId: "other.test" };

it("accepts each configured origin, redeems a bound code only on its domain, and keeps agents and pending origins out", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "comms-passkey-code-http-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const seed = join(directory, "seed");
	await mkdir(seed);
	await writeFile(join(seed, "child.ts"), 'throw new Error("intentionally unavailable app");');
	const child = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: {
			...process.env,
			ENTRY: join(seed, "child.ts"),
			DATA_DIR: join(directory, "data"),
			ADDITIONAL_ORIGIN: other.origin,
		},
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
	// The new domain is this board reached as http://localhost, so the board fetches its own proof through it.
	const added = { origin: `http://localhost:${new URL(url).port}`, rpId: "localhost" };
	await expect.poll(async () => (await fetch(`${url}/setup`)).status).toBe(200);
	const setupCode = /\/setup is open, code ([A-F0-9]+)/.exec(output)?.[1];
	expect(setupCode).toBeTruthy();
	const send = (
		path: string,
		input: unknown,
		origin: string,
		headers: Readonly<Record<string, string>> = {},
		method: "POST" | "DELETE" = "POST",
	) =>
		fetch(`${url}${path}`, {
			method,
			headers: { "content-type": "application/json", origin, ...headers },
			body: JSON.stringify(input),
		});
	const errorCode = async (response: Response) => Schema.decodeUnknownSync(failure)(await response.json()).error.code;
	const first = authenticator(),
		second = authenticator();
	const counters = new Map<string, number>();
	const assertion = (device: ReturnType<typeof authenticator>, challenge: string, party: typeof primary) => {
		const counter = (counters.get(device.id) ?? 0) + 1;
		counters.set(device.id, counter);
		return device.assertion(challenge, counter, party.origin, party.rpId);
	};
	const setup = Schema.decodeUnknownSync(ceremony)(
		await (await send("/_boot/auth/setup/options", { code: setupCode }, primary.origin)).json(),
	);
	expect(
		(
			await send(
				"/_boot/auth/setup/verify",
				{ id: setup.id, response: first.registration(setup.options.challenge) },
				primary.origin,
			)
		).status,
	).toBe(200);
	const signIn = async (device: ReturnType<typeof authenticator>, party: typeof primary) => {
		const options = await send("/_boot/auth/login/options", {}, party.origin);
		expect(options.status).toBe(200);
		const login = Schema.decodeUnknownSync(ceremony)(await options.json());
		const verified = await send(
			"/_boot/auth/login/verify",
			{ id: login.id, response: assertion(device, login.options.challenge, party) },
			party.origin,
		);
		return { status: verified.status, cookie: verified.headers.get("set-cookie")?.split(";")[0] ?? "" };
	};
	const { cookie } = await signIn(first, primary);
	expect(cookie).not.toBe("");
	const human = { cookie };

	// Every configured origin passes boot's origin checks; anything else is refused.
	for (const origin of [primary.origin, other.origin])
		expect((await send("/_boot/auth/login/options", {}, origin)).status).toBe(200);
	for (const origin of ["https://evil.test", "https://sub.comms.test", added.origin]) {
		const refused = await send("/_boot/auth/login/options", {}, origin);
		expect(refused.status).toBe(403);
		expect(await errorCode(refused)).toBe("origin_invalid");
	}
	expect((await send("/_boot/auth/passkeys/options", { label: "Key" }, other.origin, human)).status).toBe(200);
	expect((await send("/_boot/auth/passkeys/options", { label: "Key" }, "https://evil.test", human)).status).toBe(403);
	// The proxy's human write check: a configured origin reaches the (unavailable) app; another origin does not.
	expect((await send("/api/anything", {}, other.origin, human)).status).toBe(503);
	expect((await send("/api/anything", {}, "https://evil.test", human)).status).toBe(403);
	// A passkey created for comms.test does not sign in on other.test.
	expect((await signIn(first, other)).status).toBe(401);

	const proof = async (action: string, params: unknown, party = primary, device = first, headers = human) => {
		const response = await send("/_boot/auth/challenge", { action, params }, party.origin, headers);
		expect(response.status).toBe(200);
		const challenge = Schema.decodeUnknownSync(ceremony)(await response.json());
		return Buffer.from(
			JSON.stringify({ id: challenge.id, response: assertion(device, challenge.options.challenge, party) }),
		).toString("base64url");
	};
	// Agent tokens never create or redeem codes.
	const bearer = { authorization: `Bearer ${"a".repeat(43)}` };
	expect(
		(await send("/_boot/auth/challenge", { action: "passkey.code", params: {} }, primary.origin, bearer)).status,
	).toBe(401);
	expect((await send("/_boot/auth/passkey-code", {}, primary.origin, bearer)).status).toBe(401);
	expect((await send("/_boot/auth/passkey-code/options", { code: "0" }, primary.origin, bearer)).status).toBe(401);
	expect(
		(await send("/_boot/auth/passkey-code/options", { code: "0" }, primary.origin, { ...human, ...bearer })).status,
	).toBe(401);
	// Creation needs a fresh assertion whose payload names exactly the target origin.
	expect((await send("/_boot/auth/passkey-code", { origin: added.origin }, primary.origin, human)).status).toBe(401);
	const unbound = await proof("passkey.code", {});
	const mismatched = await send("/_boot/auth/passkey-code", { origin: added.origin }, primary.origin, {
		...human,
		[assertionHeader]: unbound,
	});
	expect(mismatched.status).toBe(401);
	expect(await errorCode(mismatched)).toBe("challenge_invalid");
	const created = await send("/_boot/auth/passkey-code", { origin: added.origin }, primary.origin, {
		...human,
		[assertionHeader]: await proof("passkey.code", { origin: added.origin }),
	});
	expect(created.status).toBe(200);
	expect(created.headers.get("cache-control")).toBe("no-store");
	const code = Schema.decodeUnknownSync(issued)(await created.json());
	expect(code.origin).toBe(added.origin);

	// The pending origin still grants nothing, including human writes from it.
	expect((await send("/_boot/auth/login/options", {}, added.origin)).status).toBe(403);
	expect((await send("/_boot/auth/passkeys/options", { label: "Key" }, added.origin, human)).status).toBe(403);
	expect((await send("/api/anything", {}, added.origin, human)).status).toBe(403);
	// Only exact public paths exist for redemption.
	const page = await fetch(`${url}/auth/passkey-code`);
	expect(page.status).toBe(200);
	expect(await page.text()).toContain('data-mode="code"');
	expect((await fetch(`${url}/auth/passkey-code/extra`)).status).not.toBe(200);
	// A malformed code, an unknown selector, and the live selector from an origin that is neither allowed nor bound
	// all get byte-identical refusals, so nobody can learn whether a selector is live.
	const refusal = async (input: string, origin: string) => {
		const response = await send("/_boot/auth/passkey-code/options", { code: input }, origin);
		return { status: response.status, body: await response.text() };
	};
	const baseline = await refusal(`${"0".repeat(12)}-${code.code.slice(13)}`, added.origin);
	expect(baseline.status).toBe(401);
	expect(JSON.parse(baseline.body).error.code).toBe("passkey_code_invalid");
	for (const [input, origin] of [
		["not a code", added.origin],
		[code.code, other.origin],
		[code.code, primary.origin],
		[code.code.toLowerCase(), "https://evil.test"],
	] as const)
		expect(await refusal(input, origin)).toEqual(baseline);

	const options = await send("/_boot/auth/passkey-code/options", { code: code.code }, added.origin);
	expect(options.status).toBe(200);
	const redemption = Schema.decodeUnknownSync(ceremony)(await options.json());
	const redeemed = await send(
		"/_boot/auth/passkey-code/verify",
		{ id: redemption.id, response: second.registration(redemption.options.challenge, added.origin, added.rpId) },
		added.origin,
	);
	expect(redeemed.status).toBe(200);
	const addedCookie = redeemed.headers.get("set-cookie")?.split(";")[0] ?? "";
	expect(addedCookie).toMatch(/^__Host-comms_session=/);
	// The proof route is an exact public path; unknown ids and query strings reveal nothing.
	for (const probe of ["x".repeat(43), "short", `${"x".repeat(43)}?probe=1`]) {
		const response = await fetch(`${url}/_boot/auth/origin-proof/${probe}`);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	}
	expect((await fetch(`${url}/_boot/auth/origin-proof/${"x".repeat(43)}/extra`)).status).not.toBe(200);
	expect((await send("/_boot/auth/passkey-code/options", { code: code.code }, added.origin)).status).toBe(401);

	// The activated origin now signs in with its own passkey and accepts human writes.
	expect((await signIn(second, added)).status).toBe(200);
	expect(
		(await send("/_boot/auth/passkeys/options", { label: "Key" }, added.origin, { cookie: addedCookie })).status,
	).toBe(200);
	const origins = await fetch(`${url}/_boot/auth/origins`, { headers: human });
	expect(origins.status).toBe(200);
	expect(JSON.stringify(await origins.json())).toContain(
		`"origin":"${added.origin}","rp_id":"localhost","source":"runtime"`,
	);

	// Removal refuses the request's own origin, configured origins and origins with bound passkeys.
	for (const [target, party, device, status, expected] of [
		[added.origin, added, second, 409, "origin_protected"],
		[other.origin, primary, first, 409, "origin_protected"],
		[added.origin, primary, first, 409, "origin_has_passkeys"],
	] as const) {
		const removed = await send(
			"/_boot/auth/origins",
			{ origin: target },
			party.origin,
			{
				cookie: party === added ? addedCookie : cookie,
				[assertionHeader]: await proof("origin.remove", { origin: target }, party, device, {
					cookie: party === added ? addedCookie : cookie,
				}),
			},
			"DELETE",
		);
		expect(removed.status).toBe(status);
		expect(await errorCode(removed)).toBe(expected);
	}

	// While stored passkeys match an allowed origin, the public help says so.
	expect(await (await fetch(`${url}/_boot`)).text()).toContain("passkey_origins_ok: true");
	// Strand every passkey. Boot keeps serving and says so on each surface, without listing RP IDs publicly.
	await promisify(execFile)("bun", [
		"-e",
		`const { Database } = require("bun:sqlite"); new Database(${JSON.stringify(join(directory, "data", "boot.db"))}).run("UPDATE passkeys SET rp_id='elsewhere.test'");`,
	]);
	const help = await (await fetch(`${url}/_boot`)).text();
	expect(help).toContain("passkey_origins_ok: false");
	expect(help).not.toContain("elsewhere.test");
	const stranded = await send("/_boot/auth/login/options", {}, primary.origin);
	expect(stranded.status).toBe(409);
	expect(await errorCode(stranded)).toBe("passkey_origin_mismatch");
	const status = await fetch(`${url}/_boot/status`, { headers: human });
	expect(status.status).toBe(200);
	expect(JSON.stringify(await status.json())).toContain("elsewhere.test");
	// Existing sessions keep working.
	expect((await fetch(`${url}/_boot/auth/passkeys`, { headers: human })).status).toBe(200);

	const manifest = JSON.stringify(await (await fetch(`${url}/.well-known/agent.json`)).json());
	for (const path of [
		"/_boot/auth/passkey-code",
		"/_boot/auth/passkey-code/options",
		"/auth/passkey-code",
		"/_boot/auth/origins",
		"/_boot/auth/origin-proof/{id}",
	])
		expect(manifest).toContain(`"${path}"`);
}, 30_000);
