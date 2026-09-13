import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect } from "vitest";
import { sourcePut } from "./source-put.ts";

type Evidence = {
	readonly selected: string;
	readonly settings: readonly { readonly key: string; readonly value: string }[];
	readonly evidence: unknown;
	readonly forwardState?: unknown;
};
type Running = {
	readonly child: ChildProcess;
	readonly url: string;
	readonly state: (cookie: string, desired: string, timeout?: number) => Promise<void>;
	readonly post: (path: string, body: unknown, cookie?: string, headers?: Record<string, string>) => Promise<Response>;
};
export const remoteRestoreForward = async (fixture: {
	readonly launch: () => Promise<Running>;
	readonly stop: (child: ChildProcess) => Promise<void>;
	readonly operator: (action: string) => Promise<Evidence>;
	readonly before: Evidence;
	readonly cookie: string;
	readonly input: { readonly topic: string; readonly body: string };
	readonly key: string;
	readonly message: { readonly id: string; readonly body: string; readonly seq: number };
	readonly root: string;
	readonly backup: string;
	readonly assertion: (challenge: string) => unknown;
}) => {
	const { cookie, input, key, message } = fixture;
	const running = await fixture.launch();
	await running.state(cookie, "live");
	expect(
		(await running.post("/api/messages", { topic: "forward-marker", body: "New data required by migration" }, cookie))
			.status,
	).toBe(200);
	expect((await running.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = `import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
 const sql = yield* SqlClient.SqlClient;
 const marker = yield* sql\`SELECT body FROM messages WHERE topic='forward-marker'\`;
 if(marker.length !== 1) {
  yield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(join(fixture.root, "forward-failure-"))}+process.env.STATE,"old backup lacks required marker");
  return yield* Effect.die("old backup cannot migrate forward");
 }
 yield* sql\`CREATE TABLE restore_forward_owned(value TEXT)\`;
 yield* sql\`INSERT INTO restore_forward_owned VALUES('agent data')\`;
});`;
	const edited = await sourcePut(`${running.url}/api/fs/app/migrations/900_forward.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: source,
	});
	expect(await edited.json()).toMatchObject({ status: "live" });
	await running.state(cookie, "live");
	const state = async () =>
		Schema.decodeUnknownSync(Schema.Struct({ child: Schema.Struct({ generation: Schema.Int }) }))(
			await (await fetch(`${running.url}/_boot/status`, { headers: { cookie } })).json(),
		);
	const accepted = await state();
	// A fresh dump must include the successfully migrated agent-owned table under the checked-in roles.
	expect((await running.post("/_boot/db/backup", {}, cookie)).status).toBe(200);
	const challenge = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) }),
	)(
		await (
			await running.post("/_boot/auth/challenge", { action: "db.restore", params: { backup: fixture.backup } }, cookie)
		).json(),
	);
	const proof = Buffer.from(
		JSON.stringify({ id: challenge.id, response: fixture.assertion(challenge.options.challenge) }),
	).toString("base64url");
	const response = await running.post("/_boot/db/restore", { id: fixture.backup }, cookie, {
		"X-Chirp-Assertion": proof,
	});
	await writeFile(join(fixture.root, "restore-forward-response.json"), await response.clone().text(), { mode: 0o600 });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ status: "failed", error: "restore_preparation_failed" });
	expect(await readFile(join(fixture.root, "forward-failure-rehearsal"), "utf8")).toBe(
		"old backup lacks required marker",
	);
	await running.state(cookie, "live");
	expect((await state()).child.generation).toBe(accepted.child.generation);
	expect(await (await running.post("/api/messages", input, cookie, { "idempotency-key": key })).json()).toMatchObject(
		message,
	);
	await fixture.stop(running.child);
	const after = await fixture.operator("inspect");
	expect(after.selected).toBe(fixture.before.selected);
	expect(after.settings).toEqual(fixture.before.settings);
	expect(after.evidence).toMatchObject({
		identity: [{ store_id: fixture.before.settings.find((row) => row.key === "app_store_id")?.value }],
		messages: expect.arrayContaining([{ id: message.id, body: message.body }]),
	});
	expect(after.forwardState).toEqual({
		ledger: [{ migration_id: 900, name: "forward" }],
		rows: [{ value: "agent data" }],
	});
	const restarted = await fixture.launch();
	await restarted.state(cookie, "live");
	expect(
		(await restarted.post("/api/messages", { topic: input.topic, body: "After refused forward restore" }, cookie))
			.status,
	).toBe(200);
	expect(await (await restarted.post("/api/messages", input, cookie, { "idempotency-key": key })).json()).toMatchObject(
		message,
	);
	expect(
		await (await fetch(`${restarted.url}/api/messages?topic=forward-marker&since=0`, { headers: { cookie } })).json(),
	).toMatchObject({ items: [{ body: "New data required by migration" }] });
	await fixture.stop(restarted.child);
	const final = await fixture.operator("inspect");
	expect(final.forwardState).toEqual(after.forwardState);
};
