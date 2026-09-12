// Public HTTP acceptance against an externally managed, disposable board image.
// The harness owns Docker lifecycle; this probe never touches either database directly.
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/process-env, effecttsgo/prefer-schema-over-json */
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { authenticator } from "../packages/boot/test/fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const message = Schema.Struct({ id: Schema.String, seq: Schema.Int, topic: Schema.String, body: Schema.String });
const savedState = Schema.Struct({ cookie: Schema.String, message, key: Schema.String, backup: Schema.String });

async function run() {
	const [phase, address, stateFile] = process.argv.slice(2);
	assert.ok(phase === "prepare" || phase === "check-restored" || phase === "check-restarted", "Unknown probe phase");
	assert.ok(address && stateFile, "Usage: remote-board-http.ts PHASE URL PRIVATE_STATE_FILE");
	const url = new URL(address);
	assert.ok(
		url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname),
		"Disposable loopback board required",
	);
	const origin = process.env.COMMS_TEST_ORIGIN ?? "https://comms.test";
	const rpId = new URL(origin).hostname;
	const request = (path: string, body?: unknown, cookie?: string, headers?: Record<string, string>) =>
		fetch(new URL(path, url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				origin,
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(cookie ? { cookie } : {}),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(180000),
			redirect: "error",
		});
	const ok = async (response: Response, label: string) => {
		// Do not print bodies: authentication failures can contain challenge material.
		assert.equal(response.status, 200, `${label}: HTTP ${response.status}`);
		return response;
	};
	const ready = async (cookie: string) => {
		const deadline = Date.now() + 180000;
		let last = "unavailable";
		while (Date.now() < deadline) {
			try {
				const response = await fetch(new URL("/_boot/status", url), {
					headers: { cookie },
					signal: AbortSignal.timeout(5000),
					redirect: "error",
				});
				if (response.ok) {
					const status = Schema.decodeUnknownSync(Schema.Struct({ child: Schema.Struct({ state: Schema.String }) }))(
						await response.json(),
					);
					last = status.child.state;
					if (last === "live") return;
				} else last = `HTTP ${response.status}`;
			} catch {
				last = "unavailable";
			}
			await setTimeout(500);
		}
		throw new Error(`Board readiness deadline: ${last}`);
	};
	const verify = async (state: typeof savedState.Type) => {
		await ready(state.cookie);
		assert.equal((await request("/api/messages")).status, 401, "Anonymous reads must be refused");
		assert.equal((await request("/api/messages", { topic: state.message.topic, body: "anonymous" })).status, 401);
		const read = await ok(
			await request(
				`/api/messages?since=0&wait=0&topic=${encodeURIComponent(state.message.topic)}`,
				undefined,
				state.cookie,
			),
			"Read restored messages",
		);
		const rows = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(message) }))(await read.json());
		assert.deepEqual(rows.items, [state.message], "Restore must retain A and remove B, preserving message identity");
		const duplicate = await ok(
			await request("/api/messages", { topic: state.message.topic, body: state.message.body }, state.cookie, {
				"idempotency-key": state.key,
			}),
			"Replay acknowledged write",
		);
		assert.deepEqual(Schema.decodeUnknownSync(message)(await duplicate.json()), state.message);
		assert.equal(
			(
				await request("/api/messages", { topic: state.message.topic, body: "conflicting retry" }, state.cookie, {
					"idempotency-key": state.key,
				})
			).status,
			409,
		);
	};
	if (phase !== "prepare") {
		assert.equal((await stat(stateFile)).mode & 0o077, 0, "Private state file permissions");
		const state = Schema.decodeSync(Schema.fromJsonString(savedState))(await readFile(stateFile, "utf8"));
		await verify(state);
		if (phase === "check-restarted") {
			const input = { topic: `${state.message.topic}/after-restart`, body: "Fresh write after restart" };
			const written = Schema.decodeUnknownSync(message)(
				await (await ok(await request("/api/messages", input, state.cookie), "Fresh post-restart write")).json(),
			);
			assert.equal(written.body, input.body);
			assert.equal(written.topic, input.topic);
			assert.ok(written.seq > state.message.seq);
			const visible = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(message) }))(
				await (
					await ok(
						await request(
							`/api/messages?since=0&wait=0&topic=${encodeURIComponent(input.topic)}`,
							undefined,
							state.cookie,
						),
						"Fresh post-restart publication",
					)
				).json(),
			);
			assert.deepEqual(visible.items, [written]);
		}
		console.log(`Remote board ${phase}: authenticated persistence and idempotency passed`);
		return;
	}
	const setupFile = process.env.COMMS_SETUP_CODE_FILE;
	assert.ok(setupFile, "COMMS_SETUP_CODE_FILE is required");
	assert.equal((await stat(setupFile)).mode & 0o077, 0, "Private setup file permissions");
	const code = (await readFile(setupFile, "utf8")).trim();
	const device = authenticator();
	let counter = 0;
	const setup = Schema.decodeUnknownSync(ceremony)(
		await (await ok(await request("/_boot/auth/setup/options", { code }), "Setup options")).json(),
	);
	await ok(
		await request("/_boot/auth/setup/verify", {
			id: setup.id,
			response: device.registration(setup.options.challenge, origin, rpId),
		}),
		"Passkey setup",
	);
	const options = Schema.decodeUnknownSync(ceremony)(
		await (await ok(await request("/_boot/auth/login/options", {}), "Login options")).json(),
	);
	const login = await ok(
		await request("/_boot/auth/login/verify", {
			id: options.id,
			response: device.assertion(options.options.challenge, ++counter, origin, rpId),
		}),
		"Passkey login",
	);
	const cookie = login.headers.get("set-cookie")?.split(";")[0];
	assert.ok(cookie, "Login cookie missing");
	await ready(cookie);
	const key = crypto.randomUUID();
	const input = { topic: `acceptance/${key}`, body: "A preserved — café 🐘 数据" };
	const first = Schema.decodeUnknownSync(message)(
		await (await ok(await request("/api/messages", input, cookie, { "idempotency-key": key }), "Initial write")).json(),
	);
	assert.equal(first.body, input.body);
	assert.equal(first.topic, input.topic);
	await verify({ cookie, message: first, key, backup: "" });
	assert.equal((await request("/_boot/db/backup", {})).status, 401);
	const backup = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String, bytes: Schema.Finite, published_through: Schema.Int }),
	)(await (await ok(await request("/_boot/db/backup", {}, cookie), "Native backup")).json());
	assert.ok(backup.bytes > 0 && backup.published_through >= first.seq);
	await ok(await request("/api/messages", { ...input, body: "B removed by restore" }, cookie), "Post-backup write");
	const beforeRestore = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(message) }))(
		await (
			await ok(
				await request(`/api/messages?since=0&wait=0&topic=${encodeURIComponent(input.topic)}`, undefined, cookie),
				"Read before restore",
			)
		).json(),
	);
	assert.deepEqual(
		beforeRestore.items.map((row) => row.body),
		[input.body, "B removed by restore"],
	);
	assert.equal(
		(await request("/_boot/db/restore", { id: backup.id }, cookie)).status,
		401,
		"Restore requires fresh assertion",
	);
	const challenge = Schema.decodeUnknownSync(ceremony)(
		await (
			await ok(
				await request("/_boot/auth/challenge", { action: "db.restore", params: { backup: backup.id } }, cookie),
				"Restore challenge",
			)
		).json(),
	);
	const proof = Buffer.from(
		JSON.stringify({
			id: challenge.id,
			response: device.assertion(challenge.options.challenge, ++counter, origin, rpId),
		}),
	).toString("base64url");
	const restored = Schema.decodeUnknownSync(
		Schema.Struct({ status: Schema.String, backup: Schema.String, restored_to_seq: Schema.Int }),
	)(
		await (
			await ok(
				await request("/_boot/db/restore", { id: backup.id }, cookie, { "X-Comms-Assertion": proof }),
				"Native restore",
			)
		).json(),
	);
	assert.equal(restored.status, "restored");
	assert.equal(restored.backup, backup.id);
	assert.equal(restored.restored_to_seq, backup.published_through);
	const state = { cookie, message: first, key, backup: backup.id };
	await verify(state);
	await writeFile(stateFile, JSON.stringify(state), { mode: 0o600, flag: "wx" });
	console.log("Remote board prepare: passkey, native backup/restore, auth boundaries and idempotency passed");
}

await run();
