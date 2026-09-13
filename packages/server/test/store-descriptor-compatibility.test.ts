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
	// Frozen from the last pre-descriptor base (dd733fe), so current channel edits
	// cannot silently change the historical APP_DATABASE-only launch contract.
	await cp(join(import.meta.dirname, "fixtures/legacy-boot-channel.ts.txt"), channelPath);
	// Keep current schemas/domain behavior, but make their consumers use the frozen
	// channel's historical filename contract. The channel itself stays byte-identical
	// and never learns APP_STORE; this is not a snapshot of the entire historical app.
	for (const [file, count] of [
		["server.ts", 1],
		["kernel/sql-read.ts", 2],
	] as const) {
		const filename = join(seed, file);
		const source = await readFile(filename, "utf8");
		expect(source.split("boot.store")).toHaveLength(count + 1);
		await writeFile(filename, source.replaceAll("boot.store", '({ _tag: "file", filename: boot.filename })'));
	}
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
