import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("preserves a published background message after boot dies immediately after rollback restarts the prior generation", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const marker = join(fixture.root, "write-after-rollback");
	const receipt = join(fixture.root, "background-receipt.json");
	const server = await readFile(join(seed, "server.ts"), "utf8");
	const trigger = 'if ((yield* Ref.get(lifecycle.state)) === "live") {';
	const background = `${trigger}
										const fs = yield* FileSystem.FileSystem;
										if ((yield* fs.exists(${JSON.stringify(marker)})) && !(yield* fs.exists(${JSON.stringify(receipt)}))) {
											const message = yield* messages.create(
												{ agent: "worker", instance: "rollback-job", request: "background", kind: "agent" },
												{ topic: "rollback", body: "published by restarted live job" }, "rollback-job-once");
											yield* fs.writeFileString(${JSON.stringify(receipt + ".tmp")}, JSON.stringify(message));
											yield* fs.rename(${JSON.stringify(receipt + ".tmp")}, ${JSON.stringify(receipt)});
										}`;
	expect(server).toContain(trigger);
	await writeFile(
		join(seed, "server.ts"),
		server.replace("\tConfig,", "\tConfig,\n\tFileSystem,").replace(trigger, background),
	);

	// Instrument only a disposable boot copy: hold the exact crash window without
	// adding a production fault switch or delaying unrelated cutover stages.
	const boot = join(fixture.root, "packages/boot");
	await cp(join(import.meta.dirname, "../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	await cp(join(import.meta.dirname, "../../boot/test/fixtures/launcher.ts"), join(boot, "test/fixtures/launcher.ts"));
	await symlink(join(import.meta.dirname, "../../boot/node_modules"), join(boot, "node_modules"));
	await mkdir(join(fixture.root, "packages/server"), { recursive: true });
	await symlink(join(import.meta.dirname, "../node_modules"), join(fixture.root, "packages/server/node_modules"));
	const cutover = await readFile(join(boot, "src/cutover.ts"), "utf8");
	const restarted = "if (prior) yield* start(prior.generation);";
	expect(cutover.split(restarted)).toHaveLength(2);
	await writeFile(
		join(boot, "src/cutover.ts"),
		cutover.replace(restarted, `${restarted}\n\t\t\t\t\t\tyield* Effect.never;`),
	);
	const app = await fixture.launch(join(seed, "server.ts"), join(boot, "test/fixtures/launcher.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await app.post("/api/messages", { topic: "rollback", body: "before rollback" }, cookie)).status).toBe(200);
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const database = await readFile(join(seed, "kernel/database.ts"), "utf8");
	const initialize = "yield* sql`PRAGMA synchronous = FULL`;";
	expect(database).toContain(initialize);
	const failed = database.replace(
		initialize,
		`${initialize}
if (process.env.STATE === "candidate") { yield* Effect.sleep("1500 millis"); return yield* Effect.die("candidate failed"); }`,
	);
	const reload = fetch(`${app.url}/api/fs/app/kernel/database.ts`, {
		method: "PUT",
		headers: { cookie, origin: "https://comms.test" },
		body: failed,
	}).catch(() => null);
	await expect
		.poll(() => fixture.sql("SELECT phase FROM cutover", "boot.db"), { timeout: 10000 })
		.toEqual([{ phase: "working" }]);
	await writeFile(marker, "allow the restarted live job to publish");
	await expect.poll(() => readFile(receipt, "utf8").catch(() => ""), { timeout: 10000 }).not.toBe("");
	const acknowledged = Schema.decodeSync(
		Schema.fromJsonString(Schema.Struct({ seq: Schema.Int, body: Schema.String })),
	)(await readFile(receipt, "utf8"));
	expect(
		await fixture.sql(
			"SELECT seq FROM events WHERE json_extract(event,'$.type')='message.created' AND json_extract(event,'$.instance')='rollback-job'",
			"boot.db",
		),
	).toEqual([{ seq: acknowledged.seq }]);
	await rm(marker);
	await app.stop("SIGKILL");
	await reload;
	const resumed = await fixture.launch();
	const again = await resumed.login();
	await resumed.ready(again);
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE instance='rollback-job'")).toEqual([
		{ seq: acknowledged.seq, body: acknowledged.body },
	]);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	expect(
		await fixture.sql(
			"SELECT seq FROM events WHERE json_extract(event,'$.type')='message.created' AND json_extract(event,'$.instance')='rollback-job'",
			"boot.db",
		),
	).toEqual([{ seq: acknowledged.seq }]);
}, 30000);
