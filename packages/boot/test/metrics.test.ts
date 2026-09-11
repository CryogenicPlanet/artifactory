import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { metrics } from "../src/metrics.ts";
import { launch } from "./fixtures/proxy-launch.ts";
import { seedSession } from "./fixtures/session.ts";

const sample = (text: string, name: string) => {
	const value = text
		.split("\n")
		.find((line) => line.startsWith(`${name} `))
		?.split(" ")[1];
	if (value === undefined) throw new Error(`Missing metric ${name}`);
	return Number(value);
};

it("keeps separate boot registries isolated and formats duration observations", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const first = yield* metrics;
			const second = yield* metrics;
			yield* first.request;
			yield* first.swap(0.25);
			const observed = yield* first.render(0);
			expect(sample(observed, "comms_requests_total")).toBe(1);
			expect(sample(observed, "comms_swap_duration_seconds_count")).toBe(1);
			expect(sample(observed, "comms_swap_duration_seconds_sum")).toBe(0.25);
			const independent = yield* second.render(0);
			expect(sample(independent, "comms_requests_total")).toBe(0);
			expect(sample(independent, "comms_swap_duration_seconds_count")).toBe(0);
		}),
	);
});

it("serves human and fs scrapes after child failure while refusing anonymous and read-only access", async (test) => {
	const app = await launch(test, "exit");
	await expect.poll(async () => (await app.state()).state).toBe("failed");
	const bearer = async (scope: string) => {
		const token = randomBytes(32).toString("base64url");
		const id = randomBytes(16).toString("hex");
		const hash = createHash("sha256").update(token).digest("hex");
		await promisify(execFile)("bun", [
			join(import.meta.dirname, "fixtures/store.ts"),
			join(app.data, "boot.db"),
			`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) VALUES('${id}','${id}','${id}','codex','access','${hash}','fixture','["${scope}"]',9999999999999,0)`,
		]);
		return token;
	};
	const url = `${app.url}/_boot/metrics`;
	expect((await fetch(url)).status).toBe(401);
	expect((await fetch(url, { headers: { authorization: `Bearer ${await bearer("read")}` } })).status).toBe(403);
	expect((await fetch(url, { headers: { authorization: `Bearer ${await bearer("fs")}` } })).status).toBe(200);
	expect((await fetch(url, { headers: { cookie: app.cookie, authorization: "Bearer invalid" } })).status).toBe(401);
	const response = await app.fetch(url);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
	expect(response.headers.get("cache-control")).toBe("no-store");
	const before = sample(await response.text(), "comms_requests_total");
	await fetch(`${app.url}/health`);
	expect(sample(await (await app.fetch(url)).text(), "comms_requests_total")).toBeGreaterThanOrEqual(before + 2);
	expect((await app.fetch(url, { method: "POST" })).status).toBe(405);
});

it("reports real lock contention, queued mutations and a completed source swap", async (test) => {
	const app = await launch(test);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const post = (path: string) =>
		app.fetch(`${app.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
	expect((await post("/api/lock")).status).toBe(200);
	const other = await seedSession(app.data);
	expect(
		(
			await fetch(`${app.url}/api/lock`, {
				method: "POST",
				headers: { cookie: other.cookie, origin: "https://comms.test", "content-type": "application/json" },
				body: "{}",
			})
		).status,
	).toBe(423);
	expect(
		(await app.fetch(`${app.url}/api/fs/app/change.txt?reload=0`, { method: "PUT", body: "changed" })).status,
	).toBe(200);
	const upload = request(`${app.url}/upload`, {
		method: "POST",
		headers: { cookie: app.cookie, origin: "https://comms.test" },
	});
	const uploaded = new Promise<void>((resolve, reject) => {
		upload.on("error", reject);
		upload.on("response", (response) => {
			response.resume();
			response.on("end", resolve);
			response.on("error", reject);
		});
	});
	upload.write("held");
	try {
		await expect.poll(async () => (await app.fetch(`${app.url}/received`)).text()).toBe("4");
		const reloaded = post("/api/reload");
		await expect
			.poll(async () => {
				const value = Schema.decodeUnknownSync(Schema.Struct({ traffic: Schema.Struct({ frozen: Schema.Boolean }) }))(
					await (await app.fetch(`${app.url}/_boot/status`)).json(),
				);
				return value.traffic.frozen;
			})
			.toBe(true);
		const queued = post("/echo");
		await expect
			.poll(async () => sample(await (await app.fetch(`${app.url}/_boot/metrics`)).text(), "comms_freeze_queue_depth"))
			.toBe(1);
		upload.end();
		await uploaded;
		expect(await (await reloaded).json()).toMatchObject({ status: "live" });
		expect((await queued).status).toBe(200);
		const text = await (await app.fetch(`${app.url}/_boot/metrics`)).text();
		expect(sample(text, "comms_lock_waits_total")).toBe(1);
		expect(sample(text, "comms_freeze_queue_depth")).toBe(0);
		expect(sample(text, "comms_swap_duration_seconds_count")).toBe(1);
		expect(sample(text, "comms_swap_duration_seconds_sum")).toBeGreaterThan(0);
	} finally {
		upload.destroy();
		await uploaded.catch(() => undefined);
	}
}, 30000);
