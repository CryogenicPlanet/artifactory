import { assertionHeader } from "@comms/protocol/headers";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

it("resets the entire source tree while preserving messages, pages, identity, tokens, history and borrowed staging across restart", async (test) => {
	const fixture = await resetFixture(test);
	await writeFile(join(fixture.seed, "seed-file"), "seed file");
	await mkdir(join(fixture.seed, "seed-directory"));
	await writeFile(join(fixture.seed, "seed-directory/child.txt"), "seed child");
	await mkdir(join(fixture.seed, "seed-empty"));
	const state = await fixture.initialize();
	const { app, cookie } = state;
	const enrollment = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, device_secret: Schema.String }))(
		await (await app.post("/auth/enroll", { name: "reset-agent", kind: "codex", host: "fixture" })).json(),
	);
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read", "write"], long_lived: false };
	const approval = await app.assertion(params);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: approval },
				body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	const pair = Schema.decodeUnknownSync(Schema.Struct({ access: Schema.String }))(
		await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json(),
	);
	// A retired optional profile table can remain on upgraded boards; reset must preserve it too.
	await fixture.sql("CREATE TABLE agents(name TEXT PRIMARY KEY,emoji TEXT,color TEXT,status TEXT NOT NULL)");
	await fixture.sql("INSERT INTO agents VALUES('legacy-agent','a','blue','preserved')");
	const identity = await fixture.sql("SELECT name,emoji,color,status FROM agents ORDER BY name");
	const passkeys = await fixture.sql("SELECT id,public_key,label,created_at FROM passkeys ORDER BY id", "boot.db");
	const tokens = await fixture.sql("SELECT id,family,hash,scopes,revoked_at FROM tokens ORDER BY id", "boot.db");
	const backups = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
		await fixture.sql("SELECT id,path FROM backups ORDER BY id", "boot.db"),
	);
	const history = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
		await fixture.sql("SELECT id,path,sha FROM versions ORDER BY id", "boot.db"),
	);
	const editable = join(fixture.root, "app");
	await rm(join(editable, "seed-file"));
	await mkdir(join(editable, "seed-file"));
	await writeFile(join(editable, "seed-file/added.txt"), "remove this");
	await rm(join(editable, "seed-directory"), { recursive: true });
	await writeFile(join(editable, "seed-directory"), "replacement file");
	await rm(join(editable, "seed-empty"), { recursive: true });
	await writeFile(join(editable, "later-only.txt"), "remove this");
	const beforeMessages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	// Preserve existing derived messages too; later system events may append new rows.
	await expect
		.poll(() => fixture.sql("SELECT 1 present FROM messages WHERE topic='system' LIMIT 1"))
		.toEqual([{ present: 1 }]);
	const allMessages = Schema.decodeUnknownSync(
		Schema.Array(Schema.Struct({ id: Schema.String, seq: Schema.Int, body: Schema.String, topic: Schema.String })),
	)(await fixture.sql("SELECT id,seq,body,topic FROM messages ORDER BY seq"));
	expect(allMessages.some((row) => row.topic === "system")).toBe(true);
	const through = Math.max(...allMessages.map((row) => row.seq));

	const reset = await state.request();
	expect(reset.status).toBe(200);
	expect(await reset.json()).toMatchObject({ status: "live" });
	await app.ready(cookie);
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(beforeMessages);
	const assertData = async () => {
		expect(await fixture.sql(`SELECT id,seq,body,topic FROM messages WHERE seq<=${through} ORDER BY seq`)).toEqual(
			allMessages,
		);

		await state.assertPreserved();
		expect(await readFile(join(editable, "reset-version.txt"), "utf8")).toBe("configured seed source");
		expect(await readFile(join(editable, "seed-file"), "utf8")).toBe("seed file");
		expect(await readFile(join(editable, "seed-directory/child.txt"), "utf8")).toBe("seed child");
		expect(await readdir(join(editable, "seed-empty"))).toEqual([]);
		expect(await readdir(editable)).not.toContain("later-only.txt");
		expect(await fixture.sql("SELECT name,emoji,color,status FROM agents ORDER BY name")).toEqual(identity);
		expect(await fixture.sql("SELECT id,public_key,label,created_at FROM passkeys ORDER BY id", "boot.db")).toEqual(
			passkeys,
		);
		expect(await fixture.sql("SELECT id,family,hash,scopes,revoked_at FROM tokens ORDER BY id", "boot.db")).toEqual(
			tokens,
		);
		expect(await fixture.sql("SELECT id,path FROM backups ORDER BY id", "boot.db")).toEqual(
			expect.arrayContaining([...backups]),
		);
		expect(await fixture.sql("SELECT id,path,sha FROM versions ORDER BY id", "boot.db")).toEqual(
			expect.arrayContaining([...history]),
		);
	};
	await assertData();
	expect((await app.post("/api/messages", { topic: "reset", body: "after reset" }, cookie)).status).toBe(200);
	const messages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	await app.stop("SIGKILL");
	const resumed = await fixture.launch();
	await resumed.ready(cookie);
	await assertData();
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
	expect(
		(
			await fetch(`${resumed.url}/api/messages?topic=reset&mark=0`, {
				headers: { authorization: `Bearer ${pair.access}` },
			})
		).status,
	).toBe(200);
	expect((await resumed.login()).length).toBeGreaterThan(0);
}, 45000);

it("refuses an incompatible seed during rehearsal without publishing source or discarding borrowed staging", async (test) => {
	const fixture = await resetFixture(test);
	const state = await fixture.initialize();
	await fixture.sql("CREATE TABLE reset_compat(current TEXT)");
	const healthPath = join(fixture.seed, "kernel/health.ts");
	const health = await readFile(healthPath, "utf8");
	const needle = "const sql = yield* SqlClient.SqlClient;";
	expect(health.split(needle)).toHaveLength(2);
	await writeFile(healthPath, health.replace(needle, `${needle}\n yield* sql\`SELECT legacy FROM reset_compat\`;`));
	const before = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
	const response = await state.request();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		status: "failed",
		error: expect.stringMatching(/incompatible_schema[\s\S]*forward source fix/),
	});
	expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe("edited source");
	expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(before);
	expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
	await state.assertPreserved();
	expect(
		(await state.app.post("/api/messages", { topic: "reset", body: "after refused reset" }, state.cookie)).status,
	).toBe(200);
	await state.app.ready(state.cookie);
}, 45000);

it.for(["rehearsal", "published", "accepted"] as const)(
	"preserves borrowed staging and acknowledged data after reset SIGKILL at %s",
	{ timeout: 45000 },
	async (boundary, test) => {
		const fixture = await resetFixture(test);
		const filename = join(fixture.boot, "src/cutover.ts");
		const source = await readFile(filename, "utf8");
		const armed = join(fixture.root, "reset-crash-armed");
		const reached = join(fixture.root, "reset-crash-reached");
		const needle =
			boundary === "rehearsal"
				? "const report = yield* rehearsed.process.health.pipe("
				: boundary === "published"
					? "const candidate = yield* supervisor"
					: "const freezeMs = (yield* DateTime.nowAsDate).getTime() - frozenAt;";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`if (yield* fs.exists(${JSON.stringify(armed)})) {
 yield* fs.writeFileString(${JSON.stringify(reached)}, ${JSON.stringify(boundary)});
 yield* Effect.never;
}\n${needle}`,
			),
		);
		const state = await fixture.initialize();
		await writeFile(armed, "pause reset only");
		const request = state.request();
		// Observe refusal/transport failure before the hook instead of hiding it behind a marker timeout.
		const pending = request.catch(() => null);
		try {
			await Promise.race([
				expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe(boundary),
				request.then(async (response) => {
					throw new Error(`Reset completed before ${boundary}: HTTP ${response.status} ${await response.text()}`);
				}),
			]);
		} catch (cause) {
			const output = state.app
				.output()
				.replace(/\/setup is open, code \S+/g, "/setup code [redacted]")
				.replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]");
			throw new Error(`Reset did not reach ${boundary}. Boot output: ${output}`, { cause });
		}
		expect(await fixture.sql("SELECT cutover_in_flight,reset_pin FROM edit_lock", "boot.db")).toEqual([
			{ cutover_in_flight: 1, reset_pin: 1 },
		]);
		expect(await fixture.sql("SELECT phase FROM cutover", "boot.db")).toEqual(
			boundary === "accepted" ? [{ phase: "accepted" }] : [],
		);
		// Accepted traffic is public before the old child is retired or the lock finalized.
		expect(
			(await state.app.post("/api/messages", { topic: "reset", body: `acknowledged during ${boundary}` }, state.cookie))
				.status,
		).toBe(200);
		const messages = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		await state.app.stop("SIGKILL");
		await pending;
		await rm(armed);
		const resumed = await fixture.launch();
		await resumed.ready(state.cookie);
		await state.assertPreserved();
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(messages);
		expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe(
			boundary === "rehearsal" ? "edited source" : "configured seed source",
		);
		expect(await fixture.sql("SELECT * FROM cutover", "boot.db")).toEqual([]);
		expect(
			await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		).toEqual([{ count: 1 }]);
		expect((await resumed.post("/api/messages", { topic: "reset", body: "after recovery" }, state.cookie)).status).toBe(
			200,
		);
		const after = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		await resumed.stop("SIGKILL");
		const again = await fixture.launch();
		await again.ready(state.cookie);
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(after);
	},
);

it("releases its synthetic lock when the authorizing session logs out during reset rehearsal", async (test) => {
	const fixture = await resetFixture(test);
	const filename = join(fixture.boot, "src/cutover.ts");
	const source = await readFile(filename, "utf8");
	const armed = join(fixture.root, "reset-logout-armed");
	const reached = join(fixture.root, "reset-logout-reached");
	const released = join(fixture.root, "reset-logout-release");
	const needle = "const report = yield* rehearsed.process.health.pipe(";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		filename,
		source.replace(
			needle,
			`if (yield* fs.exists(${JSON.stringify(armed)})) {
 yield* fs.writeFileString(${JSON.stringify(reached)}, "rehearsal");
 while (!(yield* fs.exists(${JSON.stringify(released)}))) yield* Effect.sleep("20 millis");
}\n${needle}`,
		),
	);
	const state = await fixture.initialize();
	expect(
		(
			await fetch(`${state.app.url}/api/lock`, {
				method: "DELETE",
				headers: { cookie: state.cookie, origin: "https://comms.test" },
			})
		).status,
	).toBe(200);
	await writeFile(armed, "pause reset only");
	const pending = state.request().catch(() => null);
	await expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe("rehearsal");
	expect(await fixture.sql("SELECT cutover_in_flight,reset_pin FROM edit_lock", "boot.db")).toEqual([
		{ cutover_in_flight: 1, reset_pin: 2 },
	]);
	expect((await state.app.post("/_boot/auth/logout", {}, state.resetCookie)).status).toBe(204);
	await writeFile(released, "finish rehearsal and revalidate");
	const result = await pending;
	if (!result) throw Error("Reset response lost unexpectedly");
	expect(await result.json()).toMatchObject({ status: "failed" });
	expect(await fixture.sql("SELECT * FROM edit_lock", "boot.db")).toEqual([]);
	expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe("edited source");
	const fresh = await state.app.login();
	expect((await state.app.post("/api/lock", {}, fresh)).status).toBe(200);
	expect(
		(await state.app.post("/api/messages", { topic: "reset", body: "healthy after revoked reset" }, fresh)).status,
	).toBe(200);
}, 45000);

it("binds the HTTP reset to a human's exact seed proof and rejects extra controls and replay", async (test) => {
	const fixture = await resetFixture(test);
	const state = await fixture.initialize();
	const proof = await state.app.signedAssertion("app.reset", {}, state.resetCookie);
	const send = (
		body: string,
		options: {
			readonly path?: string;
			readonly cookie?: string;
			readonly origin?: string;
			readonly authorization?: string;
		} = {},
	) =>
		fetch(`${state.app.url}${options.path ?? "/_boot/reset"}`, {
			method: "POST",
			headers: {
				cookie: options.cookie ?? state.resetCookie,
				origin: options.origin ?? "https://comms.test",
				"content-type": "application/json",
				[assertionHeader]: proof,
				...(options.authorization ? { authorization: options.authorization } : {}),
			},
			body,
		});
	for (const body of ['{"withDb":true}', '{"path":"/tmp/seed"}', '{"resetData":true}'])
		expect((await send(body)).status).toBe(400);
	expect((await send("{}", { path: "/_boot/reset?withDb=1" })).status).toBe(400);
	expect((await send("{}", { origin: "https://other.test" })).status).toBe(403);
	expect((await send("{}", { cookie: state.cookie })).status).toBe(401);
	expect((await send("{}", { authorization: `Bearer ${"A".repeat(43)}` })).status).toBe(401);
	await writeFile(join(fixture.seed, "reset-version.txt"), "different image source");
	expect((await send("{}")).status).toBe(401);
	expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe("edited source");
	await state.assertPreserved();
	await writeFile(join(fixture.seed, "reset-version.txt"), "configured seed source");
	const response = await send("{}");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ status: "live" });
	expect((await send("{}")).status).toBe(401);
	await state.assertPreserved();
}, 45000);
