import { assertionHeader } from "@comms/protocol/headers";
import { Schema } from "effect";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resetFixture } from "./fixtures/source-reset.ts";

it.for(["path", "batch", "version", "generation", "latest"] as const)(
	"human source undo borrows another session's staged lock for %s and replays exactly",
	{ timeout: 45000 },
	async (selector, test) => {
		const fixture = await resetFixture(test);
		const state = await fixture.initialize();
		const rows = await fixture.sql(
			"SELECT id,batch FROM versions WHERE path='app/reset-version.txt' ORDER BY id DESC",
			"boot.db",
		);
		const item = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.Int, batch: Schema.String })))(
			rows,
		)[0];
		if (!item) throw Error("Missing history");
		const input =
			selector === "path"
				? { path: "app/reset-version.txt" }
				: selector === "batch"
					? { batch: item.batch }
					: selector === "version"
						? { version: item.id }
						: selector === "generation"
							? { generation: 1 }
							: {};
		const before = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		const response = await state.app.post("/api/revert", input, state.resetCookie, "human-undo");
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result).toMatchObject({ status: "live" });
		// Explicit version selects that version's afterimage; other selectors restore its beforeimage.
		expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe(
			selector === "version" ? "edited source" : "configured seed source",
		);
		await state.assertPreserved();
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(before);
		const generations = await fixture.sql("SELECT n FROM generations", "boot.db");
		expect(await (await state.app.post("/api/revert", input, state.resetCookie, "human-undo")).json()).toEqual(result);
		expect(await fixture.sql("SELECT n FROM generations", "boot.db")).toEqual(generations);
		await state.app.stop("SIGKILL");
		const resumed = await fixture.launch();
		await resumed.ready(state.cookie);
		expect(await (await resumed.post("/api/revert", input, state.resetCookie, "human-undo")).json()).toEqual(result);
		await state.assertPreserved();
	},
);

it.for(["published", "working", "accepted"] as const)(
	"human borrowed source undo recovers %s without losing acknowledged data",
	{ timeout: 45000 },
	async (boundary, test) => {
		const fixture = await resetFixture(test);
		const file = join(fixture.boot, "src/cutover.ts");
		const source = await readFile(file, "utf8");
		const armed = join(fixture.root, "undo-armed"),
			reached = join(fixture.root, "undo-reached");
		const needle =
			boundary === "published"
				? "const candidate = yield* supervisor"
				: boundary === "working"
					? "yield* recovery.prepare(candidate.attempt.epoch);"
					: "const freezeMs = (yield* DateTime.nowAsDate).getTime() - frozenAt;";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			file,
			source.replace(
				needle,
				`if (yield* fs.exists(${JSON.stringify(armed)})) { yield* fs.writeFileString(${JSON.stringify(reached)}, "yes"); yield* Effect.never; }\n${needle}`,
			),
		);
		const state = await fixture.initialize();
		await writeFile(armed, "yes");
		const input = { path: "app/reset-version.txt" };
		const pending = state.app.post("/api/revert", input, state.resetCookie, "crashed-human-undo").catch(() => null);
		await Promise.race([
			expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe("yes"),
			pending.then(async (response) => {
				throw Error(`Undo finished before boundary: ${response?.status} ${await response?.text()}`);
			}),
		]);
		if (boundary !== "working")
			expect(
				(await state.app.post("/api/messages", { topic: "reset", body: `ack during ${boundary}` }, state.cookie))
					.status,
			).toBe(200);
		const before = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		await state.app.stop("SIGKILL");
		await pending;
		await rm(armed);
		const resumed = await fixture.launch();
		await resumed.ready(state.cookie);
		await state.assertPreserved();
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(before);
		const replay = await resumed.post("/api/revert", input, state.resetCookie, "crashed-human-undo");
		expect(replay.status).toBe(boundary === "accepted" ? 200 : 409);
		expect(await replay.json()).toMatchObject(
			boundary === "accepted" ? { status: "live" } : { error: { code: "source_revert_interrupted" } },
		);
		const generations = await fixture.sql("SELECT n FROM generations", "boot.db");
		await resumed.stop("SIGKILL");
		const again = await fixture.launch();
		await again.ready(state.cookie);
		expect(await fixture.sql("SELECT n FROM generations", "boot.db")).toEqual(generations);
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(before);
	},
);

it("queues a human undo behind cutover and rechecks logout before borrowing", async (test) => {
	const fixture = await resetFixture(test);
	const file = join(fixture.boot, "src/cutover.ts");
	const armed = join(fixture.root, "queue-armed"),
		reached = join(fixture.root, "queue-reached"),
		release = join(fixture.root, "queue-release"),
		queued = join(fixture.root, "undo-queued");
	let source = await readFile(file, "utf8");
	// Match the complete declaration so the injected statement cannot split its initializer.
	const needle = "const report = yield* rehearsed.process.health.pipe(";
	expect(source.split(needle)).toHaveLength(2);
	source = source.replace(
		needle,
		`if (yield* fs.exists(${JSON.stringify(armed)})) { yield* fs.writeFileString(${JSON.stringify(reached)}, "yes"); while (!(yield* fs.exists(${JSON.stringify(release)}))) yield* Effect.sleep("20 millis"); }\n${needle}`,
	);
	const gate = "\tconst revertHuman =";
	const offset = source.indexOf(gate);
	expect(offset).toBeGreaterThan(0);
	const prefix = source.slice(0, offset),
		suffix = source
			.slice(offset)
			.replace(
				"supervisor.operationGate.withPermit(",
				`fs.writeFileString(${JSON.stringify(queued)}, "yes").pipe(Effect.andThen(supervisor.operationGate.withPermit(`,
			)
			.replace("\n\t\t);", "\n\t\t)));");
	await writeFile(file, prefix + suffix);
	const state = await fixture.initialize();
	const human = await state.app.login();
	await writeFile(armed, "yes");
	const reset = state.request();
	await expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe("yes");
	const pending = state.app.post("/api/revert", { path: "app/reset-version.txt" }, human);
	await expect.poll(() => readFile(queued, "utf8").catch(() => ""), { timeout: 15000 }).toBe("yes");
	expect((await state.app.post("/_boot/auth/logout", {}, human)).status).toBe(204);
	await writeFile(release, "yes");
	expect(await (await reset).json()).toMatchObject({ status: "live" });
	expect((await pending).status).toBe(401);
	await state.assertPreserved();
	expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe("configured seed source");
}, 45000);

it("refuses a foreign agent and wrong Origin without changing borrowed staging", async (test) => {
	const fixture = await resetFixture(test),
		state = await fixture.initialize();
	const params = { agent: "foreign-agent", label: "fixture", scopes: ["read", "write", "fs"], long_lived: false };
	const proof = await state.app.signedAssertion("token.mint", params, state.cookie);
	const minted = await fetch(`${state.app.url}/_boot/tokens`, {
		method: "POST",
		headers: {
			cookie: state.cookie,
			origin: "https://comms.test",
			"content-type": "application/json",
			[assertionHeader]: proof,
		},
		body: JSON.stringify(params),
	});
	expect(minted.status).toBe(200);
	const pair = await minted.json();
	const input = { path: "app/reset-version.txt" };
	const agent = await fetch(`${state.app.url}/api/revert`, {
		method: "POST",
		headers: { authorization: `Bearer ${pair.access}`, "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	expect(agent.status).toBe(423);
	expect(await agent.json()).toMatchObject({ error: { code: "locked" } });
	const origin = await fetch(`${state.app.url}/api/revert`, {
		method: "POST",
		headers: { cookie: state.resetCookie, origin: "https://evil.test", "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	expect(origin.status).toBe(403);
	await state.assertPreserved();
	expect(await readFile(join(fixture.root, "app/reset-version.txt"), "utf8")).toBe("edited source");
}, 45000);
