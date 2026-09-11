import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { combinedFixture, combinedReceipt } from "./fixtures/combined-restore.ts";

it("restores the exact pre-flip data and complete source into a new generation, preserves another session's staging and pages, and replays without replacing later writes", async (test) => {
	const fixture = await combinedFixture(test);
	const state = await fixture.initialize();
	const request = await state.signed("combined-first-result");
	const response = await request(state.app.url);
	expect(response.status).toBe(200);
	const result = Schema.decodeUnknownSync(combinedReceipt)(await response.json());
	expect(result).toMatchObject({
		status: "restored",
		backup: state.saved.id,
		source_generation: state.target,
		restored_to_seq: state.saved.published_through,
	});
	expect(result.generation).toBeGreaterThan(state.prior);
	await state.app.ready(state.cookie);
	expect((await fixture.status(state.app.url, state.cookie)).child.generation).toBe(result.generation);
	await fixture.assertSource(true);
	await fixture.assertRuntime(state.app.url, state.cookie, true);
	expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual([{ body: "A before target pre-flip" }]);
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(state.staging);
	expect(
		await fixture.sql("SELECT id,holder_family,agent,cutover_in_flight,pending_release FROM edit_lock", "boot.db"),
	).toEqual(state.lock);
	const safety = (await fixture.backups()).find((row) => row.id === result.safety_backup);
	if (!safety) throw Error("Missing safety backup");
	expect(
		await fixture.sql("SELECT seq,body FROM messages ORDER BY seq", join("backups", basename(safety.path))),
	).toEqual(state.beforeMessages);
	expect(await fixture.sql(`SELECT backup_id FROM generations WHERE n=${result.generation}`, "boot.db")).toEqual([
		{ backup_id: state.saved.id },
	]);
	await state.create("D after accepted restore");
	const fresh = await fixture.sql("SELECT seq,body FROM messages ORDER BY seq");
	expect(await (await request(state.app.url)).json()).toEqual(result);
	expect(await fixture.sql("SELECT seq,body FROM messages ORDER BY seq")).toEqual(fresh);
	await state.app.stop();
	const resumed = await fixture.launch();
	await resumed.ready(state.cookie);
	expect((await fixture.status(resumed.url, state.cookie)).child.generation).toBe(result.generation);
	expect(await (await request(resumed.url)).json()).toEqual(result);
	expect(await fixture.sql("SELECT seq,body FROM messages ORDER BY seq")).toEqual(fresh);
	await fixture.assertSource(true);
	await fixture.assertRuntime(resumed.url, state.cookie, true);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'", "boot.db"),
	).toEqual([{ count: 1 }]);
	expect(await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db")).toEqual(
		[{ count: 1 }],
	);
}, 60000);

it.for(["health failure", "HTTP cancellation"] as const)(
	"keeps current source and staging and restores fresh safety data after combined candidate %s",
	{ timeout: 60000 },
	async (failure, test) => {
		const fixture = await combinedFixture(test);
		const coordinator = join(fixture.root, "packages/boot/src/database-restore.ts");
		const source = await readFile(coordinator, "utf8");
		const marker = join(fixture.root, "combined-awaiting-health");
		const needle = 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));';
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			coordinator,
			source.replace(
				needle,
				`yield* fs.writeFileString(${JSON.stringify(marker)}, candidate.id);
			${failure === "health failure" ? 'return yield* new ChildError({ code: "combined_fixture_health_failure" });' : "yield* Effect.never;"}
			${needle}`,
			),
		);
		const state = await fixture.initialize();
		const request = await state.signed();
		const controller = new AbortController();
		test.onTestFinished(() => controller.abort());
		const pending = request(state.app.url, controller.signal).catch(() => null);
		await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 15000 }).not.toBe("");
		const candidate = await readFile(marker, "utf8");
		if (failure === "HTTP cancellation") {
			expect(await fixture.sql("SELECT phase FROM db_restore_requests", "boot.db")).toEqual([{ phase: "working" }]);
			controller.abort();
			expect(await pending).toBeNull();
		} else {
			const response = await pending;
			if (!response) throw Error("Missing failed restore response");
			expect(await response.json()).toMatchObject({ status: "failed", source_generation: state.target });
		}
		await expect
			.poll(() => fixture.sql("SELECT phase FROM db_restore_requests", "boot.db"), { timeout: 15000 })
			.toEqual([{ phase: "failed" }]);
		await state.app.ready(state.cookie);
		await expect
			.poll(async () => (await fixture.status(state.app.url, state.cookie)).traffic.frozen, { timeout: 10000 })
			.toBe(false);
		expect((await fixture.status(state.app.url, state.cookie)).child.generation).toBe(state.prior);
		await fixture.assertSource(false);
		await fixture.assertRuntime(state.app.url, state.cookie, false);
		expect(await fixture.sql("SELECT seq,body FROM messages ORDER BY seq")).toEqual(state.beforeMessages);
		expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(state.staging);
		expect(await readFile(join(fixture.root, "attempts", `${candidate}.closed`), "utf8")).toBe(candidate);
		expect(
			await fixture.sql(
				"SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'",
				"boot.db",
			),
		).toEqual([{ count: 0 }]);

		await state.create("D after rejected combined restore");
		const fresh = await fixture.sql("SELECT seq,body FROM messages ORDER BY seq");
		await state.app.stop();
		const resumed = await fixture.launch();
		await resumed.ready(state.cookie);
		expect(await (await request(resumed.url)).json()).toMatchObject({ status: "failed" });
		expect(await fixture.sql("SELECT seq,body FROM messages ORDER BY seq")).toEqual(fresh);
		await fixture.assertSource(false);
		await fixture.assertRuntime(resumed.url, state.cookie, false);
	},
);

it("preserves accepted data and the restore pin on source conflict, rejects a competing restore, and finishes only the bound publication after repair", async (test) => {
	const fixture = await combinedFixture(test);
	const publisher = join(fixture.root, "packages/boot/src/source-files.ts");
	const source = await readFile(publisher, "utf8");
	const armed = join(fixture.root, "combined-conflict-armed");
	const filename = join(fixture.root, "app/restore-version.txt");
	const needle = "return yield* journal.recover;";
	expect(source.split(needle)).toHaveLength(2);
	await writeFile(
		publisher,
		source.replace(
			needle,
			`if (yield* fs.exists(${JSON.stringify(armed)})) {
		yield* fs.writeFileString(${JSON.stringify(filename)}, "external source change");
	}
	${needle}`,
		),
	);
	const state = await fixture.initialize();
	const request = await state.signed("accepted-conflict");
	await writeFile(armed, "inject third state only at combined acceptance");
	const refused = await request(state.app.url);
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({
		error: { code: "external_conflict", retriable: false, hint: expect.stringContaining("Repair") },
	});
	expect(await fixture.sql("SELECT phase,source_batch IS NOT NULL bound FROM db_restore_requests", "boot.db")).toEqual([
		{ phase: "restored", bound: 1 },
	]);
	expect(await fixture.sql("SELECT body FROM messages ORDER BY seq")).toEqual([{ body: "A before target pre-flip" }]);
	expect(await readFile(filename, "utf8")).toBe("external source change");
	expect(await fixture.sql("SELECT cutover_in_flight FROM edit_lock", "boot.db")).toEqual([{ cutover_in_flight: 1 }]);
	expect((await fetch(`${state.app.url}/api/messages?since=0`, { headers: { cookie: state.cookie } })).status).toBe(
		503,
	);
	expect((await fetch(`${state.app.url}/auth/login`)).status).toBe(200);
	const competing = await state.signed("competing-conflict");
	const blocked = await competing(state.app.url);
	expect(blocked.status).toBe(409);
	expect(await blocked.json()).toMatchObject({ error: { code: "restore_recovery_required", retriable: false } });
	expect(await fixture.sql("SELECT COUNT(*) count FROM db_restore_requests", "boot.db")).toEqual([{ count: 1 }]);
	expect(
		await fixture.sql("SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'", "boot.db"),
	).toEqual([{ count: 1 }]);
	// Repair only the third state to its exact journal before-image; replay owns the desired replacement.
	await writeFile(filename, "current generation");
	const response = await request(state.app.url);
	expect(response.status).toBe(200);
	const receipt = Schema.decodeUnknownSync(combinedReceipt)(await response.json());
	expect(receipt.status).toBe("restored");
	await fixture.assertSource(true);
	await state.app.ready(state.cookie);
	await fixture.assertRuntime(state.app.url, state.cookie, true);
	expect((await fixture.status(state.app.url, state.cookie)).child.generation).toBe(receipt.generation);
	expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(state.staging);
	expect(
		await fixture.sql("SELECT id,holder_family,agent,cutover_in_flight,pending_release FROM edit_lock", "boot.db"),
	).toEqual(state.lock);
	await state.create("D after source publication repair");
	const fresh = await fixture.sql("SELECT seq,body FROM messages ORDER BY seq");
	expect(await (await request(state.app.url)).json()).toEqual(receipt);
	expect(await fixture.sql("SELECT seq,body FROM messages ORDER BY seq")).toEqual(fresh);
}, 60000);
