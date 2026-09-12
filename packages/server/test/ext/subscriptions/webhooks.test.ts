import { sourcePut } from "../../fixtures/source-put.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "../../fixtures/conversation.ts";
import { EventRecord } from "@comms/protocol/events";

const Envelope = Schema.Struct({ subscription_id: Schema.String, event: EventRecord });
const receipt = Schema.Struct({ id: Schema.String, since: Schema.Int });
async function receiver(test: TestContext) {
	const received: Array<{
		delivery: string | undefined;
		body: typeof Envelope.Type;
		headers: Readonly<Record<string, string | string[] | undefined>>;
	}> = [];
	let status = 200,
		hold = false;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			received.push({
				delivery: request.headers["x-comms-delivery-id"]?.toString(),
				body: Schema.decodeSync(Schema.fromJsonString(Envelope))(Buffer.concat(chunks).toString("utf8")),
				headers: request.headers,
			});
			if (!hold) {
				response.statusCode = status;
				response.end();
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	test.onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw Error("No address");
	return {
		url: `http://127.0.0.1:${address.port}/hook`,
		received,
		setStatus: (value: number) => {
			status = value;
		},
		setHold: (value: boolean) => {
			hold = value;
		},
	};
}
it("persists registration receipts and checkpoints, replays uncertain delivery across restart, and cancels bounded in-flight work before deletion", async (test) => {
	const target = await receiver(test),
		fixture = await conversation(test);
	let app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const input = { filter: { topic: "delivery" }, deliver: { kind: "webhook", url: target.url } };
	const replies = await Promise.all([
		app.post("/api/subscriptions", input, cookie, "same"),
		app.post("/api/subscriptions", input, cookie, "same"),
	]);
	expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
	const first = await replies[0]?.json(),
		second = await replies[1]?.json();
	expect(first).toEqual(second);
	const subscription = Schema.decodeUnknownSync(receipt)(first);
	expect(await fixture.sql("SELECT COUNT(*) AS n FROM webhook_subscriptions")).toEqual([{ n: 1 }]);
	expect((await app.post("/api/subscriptions", { ...input, filter: { topic: "other" } }, cookie, "same")).status).toBe(
		409,
	);
	for (const url of ["file:///etc/passwd", "http://user:password@localhost/hook", "http://localhost/hook#fragment"])
		expect((await app.post("/api/subscriptions", { ...input, deliver: { kind: "webhook", url } }, cookie)).status).toBe(
			400,
		);
	await fixture.sql(
		"CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF cursor ON webhook_subscriptions WHEN NEW.cursor>OLD.cursor BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END",
	);
	const message = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }))(
		await (await app.post("/api/messages", { topic: "delivery", body: "once logically" }, cookie)).json(),
	);

	await expect.poll(() => target.received.length).toBeGreaterThanOrEqual(2);
	expect(new Set(target.received.map((item) => item.delivery))).toEqual(new Set([`${subscription.id}:${message.seq}`]));
	await app.stop();
	await fixture.sql("DROP TRIGGER fail_checkpoint");
	const previous = target.received.length;
	app = await fixture.launch();
	await app.ready(cookie);
	await expect.poll(() => target.received.length).toBeGreaterThan(previous);
	await expect.poll(() => fixture.sql("SELECT cursor FROM webhook_subscriptions")).toEqual([{ cursor: message.seq }]);
	expect(await (await app.post("/api/subscriptions", input, cookie, "same")).json()).toEqual(first);
	for (const item of target.received)
		for (const key of ["authorization", "cookie", "x-boot-secret", "x-comms-agent", "x-comms-instance"])
			expect(item.headers[key]).toBeUndefined();
	target.setStatus(503);
	await app.post("/api/messages", { topic: "delivery", body: "retry later" }, cookie);
	await expect
		.poll(() => fixture.sql("SELECT attempts,last_error FROM webhook_subscriptions"), { timeout: 5000 })
		.toEqual([{ attempts: 1, last_error: "http_503" }]);
	target.setStatus(200);
	await expect
		.poll(() => fixture.sql("SELECT attempts,last_error FROM webhook_subscriptions"), { timeout: 5000 })
		.toEqual([{ attempts: 0, last_error: null }]);
	target.setHold(true);
	const before = target.received.length;
	await app.post("/api/messages", { topic: "delivery", body: "cancel" }, cookie);
	await expect.poll(() => target.received.length).toBeGreaterThan(before);
	const removed = await fetch(app.url + `/api/subscriptions/${subscription.id}`, {
		method: "DELETE",
		headers: { cookie, origin: "https://comms.test" },
	});
	expect(removed.status).toBe(204);
	const stopped = target.received.length;
	await delay(300);
	expect(target.received.length).toBe(stopped);
	expect(await (await fetch(app.url + "/api/subscriptions", { headers: { cookie } })).json()).toEqual({ items: [] });
}, 30000);

async function enroll(
	app: Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>,
	name: string,
	scopes: ReadonlyArray<string>,
) {
	const enrollment = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, device_secret: Schema.String }))(
		await (await app.post("/auth/enroll", { name, kind: "codex", host: "test" })).json(),
	);
	const params = { id: enrollment.id, decision: "approve" as const, scopes, long_lived: false };
	const proof = await app.assertion(params);
	expect(
		(
			await fetch(app.url + `/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", "x-comms-assertion": proof },
				body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	return Schema.decodeUnknownSync(Schema.Struct({ access: Schema.String, family: Schema.String }))(
		await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json(),
	);
}
it("requires read and write, isolates ownership, and excludes boot request diagnostics from delivery", async (test) => {
	const target = await receiver(test),
		fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const owner = await enroll(app, "codex", ["read", "write"]),
		other = await enroll(app, "claude", ["read", "write"]),
		writer = await enroll(app, "writer", ["write"]);
	const call = (path: string, access: string, method = "GET", body?: unknown) =>
		fetch(app.url + path, {
			method,
			headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const input = {
		filter: { types: ["http.request", "message.created"] },
		deliver: { kind: "webhook", url: target.url },
	};
	expect((await call("/api/subscriptions", writer.access, "POST", input)).status).toBe(403);
	const subscription = Schema.decodeUnknownSync(receipt)(
		await (await call("/api/subscriptions", owner.access, "POST", input)).json(),
	);
	expect(await (await call("/api/subscriptions", other.access)).json()).toEqual({ items: [] });
	expect((await call(`/api/subscriptions/${subscription.id}`, other.access, "DELETE")).status).toBe(404);
	// Real requests publish audit records and wake the shared publication signal.
	for (const access of [other.access, owner.access, other.access])
		expect((await call("/api/me", access)).status).toBe(200);
	const auditRows = async () =>
		Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int, actor: Schema.String })))(
			await fixture.sql(
				`SELECT seq,json_extract(event,'$.actor') AS actor FROM events WHERE seq>${subscription.since} AND json_extract(event,'$.type')='http.request' AND json_extract(event,'$.payload.path')='/api/me' ORDER BY seq`,
				"boot.db",
			),
		);
	await expect.poll(async () => (await auditRows()).length).toBe(3);
	// Public messages from either actor remain deliverable; request diagnostics do not.
	const otherMarker = await call("/api/messages", other.access, "POST", {
		topic: "delivery-privacy",
		body: "another agent public message",
	});
	expect(otherMarker.status).toBe(200);
	const otherMessage = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }))(await otherMarker.json());
	// The later marker proves the worker progressed past both messages and the excluded requests.
	const marker = await call("/api/messages", owner.access, "POST", {
		topic: "delivery-privacy",
		body: "application event still delivered",
	});
	expect(marker.status).toBe(200);
	const message = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }))(await marker.json());
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ cursor: Schema.Int })))(
					await fixture.sql("SELECT cursor FROM webhook_subscriptions"),
				)[0]?.cursor ?? 0,
		)
		.toBeGreaterThanOrEqual(message.seq);
	expect(target.received.find((item) => item.body.event.seq === otherMessage.seq)?.body.event.actor).toBe("claude");
	expect(target.received.find((item) => item.body.event.seq === message.seq)?.body.event.actor).toBe("codex");
	expect(target.received.every((item) => item.body.event.type === "message.created")).toBe(true);
	expect(
		(
			await fetch(app.url + `/api/subscriptions/${subscription.id}`, {
				method: "DELETE",
				headers: { cookie, origin: "https://comms.test" },
			})
		).status,
	).toBe(204);
}, 20000);

it("does not send after a durable unpublished deletion or after the writer epoch is revoked", async (test) => {
	const target = await receiver(test),
		fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const subscription = Schema.decodeUnknownSync(receipt)(
		await (
			await app.post(
				"/api/subscriptions",
				{ filter: { topic: "guard" }, deliver: { kind: "webhook", url: target.url } },
				cookie,
			)
		).json(),
	);
	// Model a committed deletion whose public event is still beyond the fence.
	await fixture.sql(`UPDATE webhook_subscriptions SET deleted_seq=1000000000 WHERE id='${subscription.id}'`);
	const message = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }))(
		await (
			await app.post("/api/messages", { topic: "guard", body: "published while delivery is suppressed" }, cookie)
		).json(),
	);
	await delay(350);
	expect(target.received).toEqual([]);
	const original = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ epoch: Schema.String })))(
		await fixture.sql("SELECT epoch FROM kernel_writer"),
	)[0];
	if (!original) throw Error("Missing writer epoch");
	await fixture.sql("UPDATE kernel_writer SET epoch='fenced-test'");
	await fixture.sql(`UPDATE webhook_subscriptions SET deleted_seq=NULL WHERE id='${subscription.id}'`);
	// The direct fault injection does not emit; a normal request wakes delivery while the epoch is revoked.
	expect((await fetch(app.url + "/api/me", { headers: { cookie } })).status).toBe(200);
	await delay(350);
	expect(target.received).toEqual([]);
	expect(await fixture.sql("SELECT cursor FROM webhook_subscriptions")).toEqual([{ cursor: subscription.since }]);
	await fixture.sql(`UPDATE kernel_writer SET epoch='${original.epoch}'`);
	await expect.poll(() => fixture.sql("SELECT cursor FROM webhook_subscriptions")).toEqual([{ cursor: message.seq }]);
	expect(target.received.map((item) => item.body.event.seq)).toEqual([message.seq]);
}, 15000);

it("aborts live delivery during cutover, emits no rehearsal callbacks, and resumes the durable cursor afterward", async (test) => {
	const target = await receiver(test),
		fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const subscription = Schema.decodeUnknownSync(receipt)(
		await (
			await app.post(
				"/api/subscriptions",
				{ filter: { topic: "cutover" }, deliver: { kind: "webhook", url: target.url } },
				cookie,
			)
		).json(),
	);
	target.setHold(true);
	const message = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }))(
		await (await app.post("/api/messages", { topic: "cutover", body: "retain across cutover" }, cookie)).json(),
	);
	await expect.poll(() => target.received.length).toBeGreaterThan(0);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const reloaded = await sourcePut(app.url + "/api/fs/app/ext/zz-webhook-test.ts", {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: "export default api=>{};",
	});
	expect(await reloaded.json()).toMatchObject({ status: "live" });
	target.setHold(false);
	await expect
		.poll(() => fixture.sql("SELECT cursor FROM webhook_subscriptions"), { timeout: 6000 })
		.toEqual([{ cursor: message.seq }]);
	expect(target.received.length).toBeGreaterThanOrEqual(2);
	expect(new Set(target.received.map((item) => item.delivery))).toEqual(new Set([`${subscription.id}:${message.seq}`]));
}, 25000);
