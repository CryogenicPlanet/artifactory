import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { combinedFixture, combinedReceipt } from "./fixtures/combined-restore.ts";

it.for(["restoring", "working", "accepted", "mid-source", "before-activation"] as const)(
	"recovers combined source and DB authority after SIGKILL at %s, including large files and structural replacements",
	{ timeout: 60000 },
	async (boundary, test) => {
		const fixture = await combinedFixture(test);
		const armed = join(fixture.root, "combined-crash-armed");
		const reached = join(fixture.root, "combined-crash-reached");
		const filename = join(
			fixture.root,
			"packages/boot/src",
			boundary === "accepted"
				? "source-files.ts"
				: boundary === "mid-source"
					? "source-tree-publication.ts"
					: "database-restore.ts",
		);
		const source = await readFile(filename, "utf8");
		const needle =
			boundary === "restoring"
				? "yield* backup.restoreInto(target);"
				: boundary === "working"
					? 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));'
					: boundary === "accepted"
						? "return yield* journal.recover;"
						: boundary === "mid-source"
							? "yield* fs.rename(temporary, absolute);"
							: 'yield* supervisor.activate(candidate, "live").pipe(Effect.provideContext(context));';
		expect(source.split(needle)).toHaveLength(2);
		const pause = `if (${boundary === "mid-source" ? 'change.path === "app/large.txt" && ' : ""}(yield* fs.exists(${JSON.stringify(armed)}))) {
			yield* fs.writeFileString(${JSON.stringify(reached)}, ${JSON.stringify(boundary)});
			yield* Effect.never;
		}`;
		// Only disposable fixture code is instrumented, with exact anchors checked above.
		await writeFile(
			filename,
			source.replace(needle, boundary === "mid-source" ? `${needle}\n${pause}` : `${pause}\n${needle}`),
		);
		const state = await fixture.initialize();
		const request = await state.signed(`crash-${boundary}`);
		await writeFile(armed, "pause this combined restore only");
		const pending = request(state.app.url).catch(() => null);
		await expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 20000 }).toBe(boundary);
		const accepted = boundary === "accepted" || boundary === "mid-source" || boundary === "before-activation";
		expect(await fixture.sql("SELECT phase FROM db_restore_requests", "boot.db")).toEqual([
			{ phase: accepted ? "restored" : boundary },
		]);
		if (boundary === "restoring" || boundary === "working" || boundary === "accepted")
			await fixture.assertSource(false);
		if (boundary === "mid-source") {
			// The >1 MiB file has already replaced its prior image when boot dies.
			expect(await readFile(join(fixture.root, "app/large.txt"), "utf8")).toBe("retained source bytes\n".repeat(55000));
			expect(
				await fixture.sql(
					"SELECT state FROM source_batches WHERE id=(SELECT source_batch FROM db_restore_requests)",
					"boot.db",
				),
			).toEqual([{ state: "publishing" }]);
		}
		if (boundary === "before-activation") await fixture.assertSource(true);
		await state.app.stop("SIGKILL");
		await pending;
		await rm(armed);
		const resumed = await fixture.launch();
		await resumed.ready(state.cookie);
		const successful = boundary !== "working";
		await fixture.assertSource(successful);
		await fixture.assertRuntime(resumed.url, state.cookie, successful);
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(
			successful
				? Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int, body: Schema.String })))(
						state.beforeMessages,
					).filter((row) => row.body === "A before target pre-flip")
				: state.beforeMessages,
		);
		const response = await request(resumed.url);
		expect(response.status).toBe(successful ? 200 : 409);
		const receipt = Schema.decodeUnknownSync(combinedReceipt)(await response.json());
		expect(receipt).toMatchObject({
			status: successful ? "restored" : "failed",
			backup: state.saved.id,
			source_generation: state.target,
		});
		expect((await fixture.status(resumed.url, state.cookie)).child.generation).toBe(
			successful ? receipt.generation : state.prior,
		);
		expect(await fixture.sql("SELECT * FROM staging", "boot.db")).toEqual(state.staging);
		expect(
			(await resumed.post("/api/messages", { topic: "combined", body: "D after crash recovery" }, state.cookie)).status,
		).toBe(200);
		const fresh = await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq");
		expect(await (await request(resumed.url)).json()).toEqual(receipt);
		await resumed.stop("SIGKILL");
		const again = await fixture.launch();
		await again.ready(state.cookie);
		expect(await (await request(again.url)).json()).toEqual(receipt);
		expect(await fixture.sql("SELECT seq,body FROM messages WHERE topic!='system' ORDER BY seq")).toEqual(fresh);
		await fixture.assertSource(successful);
		await fixture.assertRuntime(again.url, state.cookie, successful);
		expect(
			await fixture.sql(
				"SELECT COUNT(*) count FROM events WHERE json_extract(event,'$.type')='db.restored'",
				"boot.db",
			),
		).toEqual([{ count: successful ? 1 : 0 }]);
		expect(
			await fixture.sql("SELECT COUNT(*) count FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		).toEqual([{ count: 1 }]);
	},
);
