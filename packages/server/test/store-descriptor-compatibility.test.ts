import { sourcePut } from "./fixtures/source-put.ts";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("restarts a retained APP_DATABASE-only generation after a candidate corrupts its store and fails", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "legacy-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const channelPath = join(seed, "kernel/boot-channel.ts");
	const channel = await readFile(channelPath, "utf8");
	// This saved generation has the pre-descriptor environment contract and opens
	// real SQLite through the complete server, including migrations and writes.
	const legacy = channel
		.replace('import { childStore, parseDescriptor, StoreError } from "@comms/storage/store";\n', "")
		.replace(
			/\tconst descriptor = yield\* Config.Redacted\("APP_STORE"\);[\s\S]*?\tconst filename = store._tag === "file" \? store.filename : null;/,
			'\tconst filename = yield* Config.String("APP_DATABASE");\n\tconst store = { _tag: "file" as const, filename };',
		);
	expect(legacy).not.toContain("APP_STORE");
	expect(legacy).not.toBe(channel);
	await writeFile(channelPath, legacy);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "legacy", body: "before" }, cookie)).status).toBe(200);
	const schema = await readFile(join(seed, "ext/core/schema.ts"), "utf8");
	const deleted = join(fixture.root, "candidate-deleted");
	const failing = schema.replace(
		"yield* sql`PRAGMA synchronous = FULL`;",
		`yield* sql\`PRAGMA synchronous = FULL\`; if (process.env.STATE === "candidate") { yield* sql\`DELETE FROM messages\`; yield* Effect.promise(() => Bun.write(${JSON.stringify(deleted)}, "deleted")); return yield* Effect.die("candidate failed"); }`,
	);
	expect(failing).not.toBe(schema);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const edited = await sourcePut(`${app.url}/api/fs/app/ext/core/schema.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: failing,
	});
	expect(await edited.json()).toMatchObject({ status: "failed" });
	expect(await readFile(deleted, "utf8")).toBe("deleted");
	await app.ready(cookie);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='legacy'")).toEqual([{ body: "before" }]);
	expect((await app.post("/api/messages", { topic: "legacy", body: "after fallback" }, cookie)).status).toBe(200);
	expect(await fixture.sql("SELECT good FROM generations ORDER BY n", "boot.db")).toEqual([{ good: 1 }, { good: 0 }]);
	await app.stop();
	const restarted = await fixture.launch(join(seed, "server.ts"));
	const again = await restarted.login();
	await restarted.ready(again);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='legacy' ORDER BY seq")).toEqual([
		{ body: "before" },
		{ body: "after fallback" },
	]);
	expect((await restarted.post("/api/messages", { topic: "legacy", body: "after restart" }, again)).status).toBe(200);
}, 30000);
