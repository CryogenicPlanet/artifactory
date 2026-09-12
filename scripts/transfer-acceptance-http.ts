// Public HTTP proof for disposable transfer images. The shell harness owns all store/process lifecycle.
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/process-env, effecttsgo/prefer-schema-over-json */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { authenticator } from "../packages/boot/test/fixtures/authenticator.ts";
import { EventRecord } from "../packages/protocol/src/events.ts";

const Message = Schema.Struct({ id: Schema.String, seq: Schema.Int, topic: Schema.String, body: Schema.String });
const State = Schema.Struct({ cookie: Schema.String, message: Message, key: Schema.String, backup: Schema.String });
const History = Schema.Array(
	Schema.Struct({ id: Schema.Int, batch: Schema.String, path: Schema.String, sha: Schema.NullOr(Schema.String) }),
);
const Evidence = Schema.Struct({
	storeId: Schema.String,
	generation: Schema.Int,
	published: Schema.Int,
	event: EventRecord,
	sourcePath: Schema.String,
	source: Schema.String,
	sourceHistory: History,
	pagePath: Schema.String,
	page: Schema.String,
	pageHistory: History,
	written: Schema.optionalKey(Message),
	checkedWrite: Schema.optionalKey(Message),
});
async function readPrivate<A>(filename: string, schema: Schema.Codec<A>) {
	assert.equal((await stat(filename)).mode & 0o077, 0, "Private acceptance state required");
	return Schema.decodeUnknownSync(schema)(JSON.parse(await readFile(filename, "utf8")));
}
async function save(filename: string, value: unknown) {
	const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	await rename(temporary, filename);
}
async function run(diagnostic: { phase: string; stage: string; path: string; status: number | null }) {
	const [phase, address, stateFile] = process.argv.slice(2);
	assert(
		phase === "seed-source" ||
			phase === "verify-target" ||
			phase === "verify-checked-source" ||
			phase === "verify-restarted" ||
			phase === "verify-source-refused",
		"Unknown transfer probe phase",
	);
	assert(address && stateFile, "Usage: transfer-acceptance-http.ts PHASE URL PRIVATE_STATE_FILE");
	diagnostic.phase = phase;
	const url = new URL(address);
	assert(
		url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname),
		"Disposable loopback image required",
	);
	const origin = process.env.COMMS_TEST_ORIGIN ?? "https://comms.test";
	let state = await readPrivate(stateFile, State);
	const request = async (path: string, method = "GET", body?: string, headers?: Record<string, string>) => {
		diagnostic.path = new URL(path, url).pathname.replace(/transfer-[a-f0-9-]+/g, "transfer-fixture");
		diagnostic.status = null;
		const response = await fetch(new URL(path, url), {
			method,
			headers: { origin, cookie: state.cookie, ...headers },
			...(body === undefined ? {} : { body }),
			redirect: "error",
			signal: AbortSignal.timeout(180000),
		});
		diagnostic.status = response.status;
		return response;
	};
	const ok = async (response: Response, label: string) => {
		diagnostic.stage = label;
		assert.equal(response.status, 200, `${label}: HTTP ${response.status}`);
		return response;
	};
	const json = async (path: string, body: unknown) =>
		ok(await request(path, "POST", JSON.stringify(body), { "content-type": "application/json" }), path);
	if (phase === "verify-source-refused") {
		for (const method of ["GET", "POST"]) {
			const response = await request(
				"/api/messages",
				method,
				method === "POST" ? JSON.stringify({ topic: "acceptance/refused", body: "must not commit" }) : undefined,
				{ "content-type": "application/json" },
			);
			assert.equal(response.status, 409, "Retired source must refuse serving and writing");
			const body = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }))(
				await response.json(),
			);
			assert.equal(body.error.code, "store_transferred");
		}
		console.log("Transfer source refusal passed");
		return;
	}
	if (phase !== "seed-source") {
		const filename = `${stateFile}.authenticator`;
		const saved = await readPrivate(
			filename,
			Schema.Struct({ id: Schema.String, privateKey: Schema.String, counter: Schema.Int }),
		);
		const device = authenticator(saved);
		const options = Schema.decodeUnknownSync(
			Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) }),
		)(await (await json("/_boot/auth/login/options", {})).json());
		const counter = saved.counter + 1;
		await save(filename, { ...device.state, counter });
		const response = await json("/_boot/auth/login/verify", {
			id: options.id,
			response: device.assertion(options.options.challenge, counter, origin, new URL(origin).hostname),
		});
		const cookie = response.headers.get("set-cookie")?.split(";")[0];
		assert(cookie, "Fresh passkey session missing");
		state = { ...state, cookie };
		// Keep original session in the base receipt: idempotency is scoped to that instance.
		await save(`${stateFile}.session`, { cookie });
	}
	diagnostic.stage = "existing-board-persistence";
	// Reuse the existing image auth/idempotency verifier, without printing its captured output on failure.
	try {
		await promisify(execFile)(
			process.execPath,
			[fileURLToPath(new URL("./remote-board-http.ts", import.meta.url)), "check-restored", address, stateFile],
			{ timeout: 240000, env: process.env },
		);
	} catch {
		throw new Error("Existing board HTTP persistence/idempotency acceptance failed");
	}
	const status = async () =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				child: Schema.Struct({ state: Schema.String }),
				last_good: Schema.Int,
				store_identity: Schema.Struct({ app_store_id: Schema.String, adoption_phase: Schema.String }),
			}),
		)(await (await ok(await request("/_boot/status"), "Status")).json());
	const history = async (path: string) =>
		Schema.decodeUnknownSync(Schema.Struct({ items: History }))(
			await (await ok(await request(`/api/fs/${path}?history`), "Source history")).json(),
		).items;
	const publication = async () =>
		Schema.decodeUnknownSync(Schema.Struct({ cursor: Schema.Int }))(
			await (await ok(await request("/api/events?wait=0&limit=1"), "Publication fence")).json(),
		).cursor;
	const events = async () =>
		Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(EventRecord) }))(
			await (
				await ok(
					await request(
						`/api/events?since=0&wait=0&limit=100&topic=${encodeURIComponent(state.message.topic)}&types=message.created`,
					),
					"Message events",
				)
			).json(),
		).items;
	const evidenceFile = `${stateFile}.transfer`;
	if (phase === "seed-source") {
		diagnostic.stage = "seed-source";
		const unique = crypto.randomUUID();
		const sourcePath = `app/ext/transfer-${unique}.ts`;
		const source = `// Retained transfer acceptance source ${unique}\nexport default function () {}\n`;
		await json("/api/lock", { note: "disposable transfer acceptance" });
		assert.equal((await request(`/api/fs/${sourcePath}`)).status, 404, "New source path must be absent");
		await ok(await request(`/api/fs/${sourcePath}?reload=0&baseVersion=null`, "PUT", source), "Stage retained source");
		const reload = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
			await (await json("/api/reload?release=1", {})).json(),
		);
		diagnostic.stage = "reload-result";
		assert.equal(reload.status, "live");
		const pagePath = `pages/acceptance/transfer-${unique}.md`;
		const page = `# Transfer page\nPreserved café 🐘 数据 ${unique}\n`;
		assert.equal((await request(`/api/fs/${pagePath}`)).status, 404, "New page path must be absent");
		const pageResult = Schema.decodeUnknownSync(Schema.Struct({ published: Schema.Boolean }))(
			await (await ok(await request(`/api/fs/${pagePath}?baseVersion=null`, "PUT", page), "Publish page")).json(),
		);
		diagnostic.stage = "page-published";
		assert(pageResult.published);
		diagnostic.stage = "store-status";
		const current = await status();
		assert.equal(current.child.state, "live");
		assert.equal(current.store_identity.adoption_phase, "ready", "Store adoption is not ready");
		diagnostic.stage = "retained-message-event";
		const event = (await events()).find((row) => row.message_id === state.message.id);
		assert(event, "Acknowledged message event missing");
		diagnostic.stage = "source-history";
		const sourceHistory = await history(sourcePath);
		diagnostic.stage = "page-history";
		const pageHistory = await history(pagePath);
		assert(sourceHistory.length && pageHistory.length, "Published history missing");
		diagnostic.stage = "save-evidence";
		await save(evidenceFile, {
			storeId: current.store_identity.app_store_id,
			generation: current.last_good,
			published: await publication(),
			event,
			sourcePath,
			source,
			sourceHistory,
			pagePath,
			page,
			pageHistory,
		});
	} else {
		const saved = await readPrivate(evidenceFile, Evidence);
		diagnostic.stage = "store-status";
		const current = await status();
		assert.equal(current.child.state, "live");
		assert.equal(current.store_identity.app_store_id, saved.storeId);
		assert.equal(current.store_identity.adoption_phase, "ready", "Store adoption is not ready");
		assert((await publication()) >= saved.published, "Publication cursor regressed");
		assert.deepEqual(
			(await events()).find((row) => row.seq === saved.event.seq),
			saved.event,
		);
		assert.equal(
			await (await ok(await request(`/api/fs/${saved.sourcePath}`), "Retained source bytes")).text(),
			saved.source,
		);
		assert.equal(
			await (await ok(await request(`/p/${saved.pagePath.slice(6)}?raw=1`), "Retained page bytes")).text(),
			saved.page,
		);
		assert.deepEqual(await history(saved.sourcePath), saved.sourceHistory);
		assert.deepEqual(await history(saved.pagePath), saved.pageHistory);
		for (const expected of [saved.checkedWrite, saved.written]) {
			if (!expected) continue;
			const prior = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Message) }))(
				await (
					await ok(
						await request(`/api/messages?since=0&wait=0&topic=${encodeURIComponent(expected.topic)}`),
						"Retained target write",
					)
				).json(),
			);
			assert.deepEqual(
				prior.items.find((row) => row.id === expected.id),
				expected,
			);
		}
		const input = {
			topic: `${state.message.topic}/${phase}`,
			body: `Transfer searchable nebula ${crypto.randomUUID()}`,
		};
		const written = Schema.decodeUnknownSync(Message)(await (await json("/api/messages", input)).json());
		assert(written.seq > Math.max(saved.published, saved.written?.seq ?? 0, saved.checkedWrite?.seq ?? 0));
		const found = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Message) }))(
			await (
				await ok(
					await request(`/api/messages?since=0&wait=0&topic=${encodeURIComponent(input.topic)}&q=nebula`),
					"Target search",
				)
			).json(),
		);
		assert(
			found.items.some((row) => row.id === written.id),
			"Target search omitted acknowledged message",
		);
		if (phase === "verify-checked-source") {
			assert(current.last_good >= saved.generation, "Checked source generation regressed");
			const published = await publication();
			assert(published >= written.seq, "Checked source write was not published");
			diagnostic.stage = "save-evidence";
			await save(evidenceFile, { ...saved, checkedWrite: written, published });
		} else if (phase === "verify-target") {
			await json("/api/lock", { note: "post-transfer generation allocation" });
			const sourceRead = await ok(await request(`/api/fs/${saved.sourcePath}`), "Target source base");
			const baseVersion = sourceRead.headers.get("x-comms-base-version");
			assert(baseVersion && /^[a-f0-9]{64}$/.test(baseVersion), "Source version token missing");
			await sourceRead.arrayBuffer();
			const source = `${saved.source}// Post-transfer generation allocation\n`;
			await ok(
				await request(`/api/fs/${saved.sourcePath}?reload=0&baseVersion=${baseVersion}`, "PUT", source),
				"Stage target source",
			);
			const reload = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
				await (await json("/api/reload?release=1", {})).json(),
			);
			diagnostic.stage = "reload-result";
			assert.equal(reload.status, "live");
			const after = await status();
			assert(after.last_good > saved.generation, "Target reused a source generation number");
			const sourceHistory = await history(saved.sourcePath);
			assert(sourceHistory.length > saved.sourceHistory.length);
			assert.deepEqual(sourceHistory.slice(1), saved.sourceHistory);
			diagnostic.stage = "save-evidence";
			await save(evidenceFile, { ...saved, source, sourceHistory, generation: after.last_good, written });
		} else {
			assert(current.last_good >= saved.generation, "Restart generation regressed");
			diagnostic.stage = "save-evidence";
			await save(evidenceFile, { ...saved, written });
		}
	}
	console.log(`Transfer ${phase}: public HTTP acceptance passed`);
}
async function main() {
	const diagnostic: { phase: string; stage: string; path: string; status: number | null } = {
		phase: "arguments",
		stage: "private-state",
		path: "none",
		status: null,
	};
	try {
		await run(diagnostic);
	} catch {
		// Only locally selected checkpoints and HTTP metadata; never error messages or response bodies.
		console.error(`Transfer HTTP acceptance failed: ${JSON.stringify(diagnostic)}`);
		process.exitCode = 1;
	}
}
await main();
