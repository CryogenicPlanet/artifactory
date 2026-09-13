// Public HTTP acceptance against an externally managed, disposable board image.
// The harness owns Docker lifecycle; this probe never touches either database directly.
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/process-env, effecttsgo/prefer-schema-over-json */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, stat, rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { sourcePut } from "../packages/boot/test/fixtures/source-put.ts";
import { authenticator } from "../packages/boot/test/fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const message = Schema.Struct({ id: Schema.String, seq: Schema.Int, topic: Schema.String, body: Schema.String });
const savedState = Schema.Struct({ cookie: Schema.String, message, key: Schema.String });

async function run() {
	const [phase, address, stateFile] = process.argv.slice(2);
	assert.ok(phase === "prepare" || phase === "check-restarted", "Unknown probe phase");
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
		const filename = process.env.COMMS_TEST_DIAGNOSTICS_FILE;
		if (response.status !== 200 && filename)
			await writeFile(
				`${filename}.http`,
				JSON.stringify({
					label,
					path: new URL(response.url).pathname,
					status: response.status,
					body: await response.clone().text(),
				}),
				{ mode: 0o600 },
			);
		assert.equal(response.status, 200, `${label}: HTTP ${response.status}`);
		return response;
	};
	const failedGeneration = async (cookie: string, bootStatus?: unknown) => {
		const response = await request("/_boot/generations", undefined, cookie);
		if (!response.ok) {
			await response.arrayBuffer();
			return;
		}
		const diagnostic = await response.json();
		const parsed = Schema.decodeUnknownSync(
			Schema.Struct({
				items: Schema.Array(
					Schema.Struct({
						n: Schema.Int,
						status: Schema.String,
						error: Schema.NullOr(Schema.String),
						stderr: Schema.NullOr(Schema.String),
					}),
				),
			}),
		)(diagnostic);
		const failed = parsed.items.find((item) => item.status === "failed");
		const recovery =
			bootStatus === undefined
				? undefined
				: Schema.decodeUnknownSync(
						Schema.Struct({ source_recovery_error: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
					)(bootStatus).source_recovery_error;
		const childError =
			bootStatus === undefined
				? undefined
				: Schema.decodeUnknownSync(
						Schema.Struct({ child: Schema.Struct({ error: Schema.optionalKey(Schema.NullOr(Schema.String)) }) }),
					)(bootStatus).child.error;
		if (!failed && !recovery && !childError) return;
		const filename = process.env.COMMS_TEST_DIAGNOSTICS_FILE;
		if (filename)
			await writeFile(filename, JSON.stringify({ status: bootStatus, generations: diagnostic }), { mode: 0o600 });
		throw new Error(
			`Board ${failed ? `generation failed: generation ${failed.n}` : "boot recovery failed"}${filename ? "; private diagnostics recorded" : ""}`,
		);
	};
	const ready = async (cookie: string) => {
		const deadline = Date.now() + 180000;
		let last = "unavailable";
		let lastStatus: unknown;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(new URL("/_boot/status", url), {
					headers: { cookie },
					signal: AbortSignal.timeout(5000),
					redirect: "error",
				});
				if (response.ok) {
					lastStatus = await response.json();
					const status = Schema.decodeUnknownSync(Schema.Struct({ child: Schema.Struct({ state: Schema.String }) }))(
						lastStatus,
					);
					last = status.child.state;
					if (last === "live") return;
				} else last = `HTTP ${response.status}`;
			} catch {
				last = "unavailable";
			}
			if (last === "failed") await failedGeneration(cookie, lastStatus);
			await setTimeout(500);
		}
		await failedGeneration(cookie, lastStatus);
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
			"Read acknowledged messages",
		);
		const rows = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(message) }))(await read.json());
		assert.deepEqual(rows.items, [state.message], "Restart must preserve acknowledged message identity");
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
	if (phase === "check-restarted") {
		assert.equal((await stat(stateFile)).mode & 0o077, 0, "Private state file permissions");
		const state = Schema.decodeSync(Schema.fromJsonString(savedState))(await readFile(stateFile, "utf8"));
		await verify(state);
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
		await ok(await request("/api/lock", {}, state.cookie), "Acquire failing candidate edit lock");
		await ok(
			await sourcePut(new URL("/api/fs/app/migrations/999999_expected_failure.ts?reload=0", url).href, {
				headers: { cookie: state.cookie, origin, "content-type": "text/plain" },
				body: 'import { Effect } from "effect";\nexport default Effect.die("private migration cause");\n',
				signal: AbortSignal.timeout(180000),
			}),
			"Stage failing migration",
		);
		const refused = await request("/api/reload?release=1", {}, state.cookie);
		assert.equal(refused.status, 409, "Failed remote migration requires operator repair");
		Schema.decodeUnknownSync(
			Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("remote_cutover_requires_operator") }) }),
		)(await refused.json());
		assert.equal((await request("/api/messages", undefined, state.cookie)).status, 503);
		const failed = Schema.decodeUnknownSync(
			Schema.Struct({
				items: Schema.Array(
					Schema.Struct({
						status: Schema.String,
						error: Schema.NullOr(Schema.String),
						stderr: Schema.NullOr(Schema.String),
					}),
				),
			}),
		)(
			await (
				await ok(await request("/_boot/generations", undefined, state.cookie), "Failed candidate diagnostics")
			).json(),
		).items.find((item) => item.status === "failed" && item.error?.includes("health_failed"));
		assert.ok(failed, "Original candidate error must survive the operator refusal");
		assert.match(failed.stderr ?? "", /^Kernel health failed: stage=initialize;/m);
		assert.ok(
			![failed.error, failed.stderr].some((value) => value?.includes("private migration cause")),
			"Migration causes remain private",
		);
		console.log(`Remote board ${phase}: persistence, fresh writes and failed migration refusal passed`);
		return;
	}
	assert.ok(!existsSync(stateFile), "Completed probe state already exists; use check-restarted");
	const device = authenticator();
	const setupFile = process.env.COMMS_SETUP_CODE_FILE;
	assert.ok(setupFile, "COMMS_SETUP_CODE_FILE is required");
	assert.equal((await stat(setupFile)).mode & 0o077, 0, "Private setup file permissions");
	const code = (await readFile(setupFile, "utf8")).trim();
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
			response: device.assertion(options.options.challenge, 1, origin, rpId),
		}),
		"Passkey login",
	);
	const cookie = login.headers.get("set-cookie")?.split(";")[0];
	assert.ok(cookie, "Login cookie missing");
	// Preserve authenticated diagnostic access if the first generation fails.
	await writeFile(`${stateFile}.session.tmp`, JSON.stringify({ cookie }), { mode: 0o600, flag: "wx" });
	await rename(`${stateFile}.session.tmp`, `${stateFile}.session`);
	await ready(cookie);
	const key = crypto.randomUUID();
	const input = { topic: `acceptance/${key}`, body: "A preserved — café 🐘 数据" };
	const first = Schema.decodeUnknownSync(message)(
		await (await ok(await request("/api/messages", input, cookie, { "idempotency-key": key }), "Initial write")).json(),
	);
	assert.equal(first.body, input.body);
	assert.equal(first.topic, input.topic);
	const state = { cookie, message: first, key };
	await verify(state);
	await writeFile(stateFile, JSON.stringify(state), { mode: 0o600, flag: "wx" });
	await ok(await request("/api/lock", {}, cookie), "Acquire edit lock");
	const child = Schema.Struct({
		state: Schema.String,
		generation: Schema.Int,
		pid: Schema.Int,
	});
	const status = async () =>
		Schema.decodeUnknownSync(Schema.Struct({ child }))(
			await (await ok(await request("/_boot/status", undefined, cookie), "Live child status")).json(),
		);
	const beforeReload = await status();
	const checked = Schema.decodeUnknownSync(
		Schema.Struct({
			status: Schema.Literal("schema_checked"),
			schema_check_only: Schema.Literal(true),
			report_unavailable: Schema.Literal(true),
		}),
	)(await (await ok(await request("/api/reload?check=1", {}, cookie), "Remote schema check")).json());
	assert.equal(checked.schema_check_only, true);
	assert.deepEqual((await status()).child, beforeReload.child, "Schema check must preserve the live writer");
	const reloaded = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.Literal("live") }))(
		await (await ok(await request("/api/reload?release=1", {}, cookie), "Remote source reload")).json(),
	);
	assert.equal(reloaded.status, "live");
	const beforeBackup = await status();
	assert.equal(beforeBackup.child.state, "live");
	assert.ok(
		beforeBackup.child.generation > beforeReload.child.generation,
		"Source reload must activate a new generation",
	);
	const refused = await request("/_boot/db/backup", {}, cookie);
	assert.equal(refused.status, 409, "Remote backup must refuse before disturbing the live writer");
	assert.equal(
		Schema.decodeUnknownSync(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }))(await refused.json())
			.error.code,
		"provider_backup_required",
	);
	assert.deepEqual(
		(await status()).child,
		beforeBackup.child,
		"Backup refusal must preserve the live generation and process",
	);
	await verify(state);
	console.log("Remote board prepare: auth, writes, schema check, reload and provider backup refusal passed");
}

await run();
