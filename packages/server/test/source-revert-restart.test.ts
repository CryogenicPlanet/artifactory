import { sourcePut } from "./fixtures/source-put.ts";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { storageFixture } from "./fixtures/storage-maintenance.ts";

it.for(["app-accepted", "page-journal"] as const)(
	"replays a source undo after boot SIGKILL at %s without replacing later edits",
	{ timeout: 45000 },
	async (boundary, test) => {
		const fixture = await storageFixture(test);
		const armed = join(fixture.root, "undo-armed"),
			reached = join(fixture.root, "undo-reached");
		const filename = join(
			fixture.root,
			"packages/boot/src",
			boundary === "app-accepted" ? "cutover.ts" : "source-files.ts",
		);
		const source = await readFile(filename, "utf8");
		const needle =
			boundary === "app-accepted" ? 'yield* activate(candidate, "accepted");' : "return yield* journal.recover;";
		expect(source.split(needle)).toHaveLength(2);
		await writeFile(
			filename,
			source.replace(
				needle,
				`if (yield* fs.exists(${JSON.stringify(armed)})) {
			yield* fs.writeFileString(${JSON.stringify(reached)}, "ready"); yield* Effect.never;
		}\n${needle}`,
			),
		);
		// Refuse once inside both publication gates, before the queued event check or journal admission.
		if (boundary === "page-journal") {
			const indexPath = join(fixture.root, "packages/boot/src/index.ts");
			const index = await readFile(indexPath, "utf8");
			const admission = "if ((yield* recoveryIntents(sql)).count > 0)";
			expect(index.split(admission)).toHaveLength(2);
			const refused = join(fixture.root, "undo-refused");
			await writeFile(
				indexPath,
				index.replace(
					admission,
					`if ((yield* fs.exists(${JSON.stringify(armed)})) && !(yield* fs.exists(${JSON.stringify(refused)}))) {
				yield* fs.writeFileString(${JSON.stringify(refused)}, "refused before publication");
				return yield* new SourceRejected({ code: "publication_pending", path: "recovery" });
			}
${admission}`,
				),
			);
		}
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const path = boundary === "app-accepted" ? "app/undo.txt" : "pages/undo.txt";
		if (boundary === "app-accepted") expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
		const put = async (url: string, body: string) => {
			for (let attempt = 0; ; attempt++) {
				const response = await sourcePut(`${url}/api/fs/${path}`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body,
				});
				if (
					attempt === 5 ||
					response.status !== 503 ||
					!Schema.is(Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("publication_pending") }) }))(
						await response.clone().json(),
					)
				)
					return response;
				await response.body?.cancel();
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		expect((await put(app.url, "before")).status).toBe(200);
		expect((await put(app.url, "after")).status).toBe(200);
		await writeFile(armed, "armed");
		let undoKey = "crash-undo-0";
		const pending = (async () => {
			for (let attempt = 0; ; attempt++) {
				undoKey = `crash-undo-${attempt}`;
				const response = await app.post("/api/revert", { path }, cookie, undoKey);
				const body: unknown = await response.json();
				if (
					boundary !== "page-journal" ||
					attempt === 5 ||
					response.status !== 503 ||
					!Schema.is(Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("publication_pending") }) }))(body)
				)
					return `Source undo completed before ${boundary}: ${response.status} ${JSON.stringify(body)}`;
				// The refused key retains that first outcome. Only this explicit prepublication
				// refusal permits a fresh operation; never retry a transport failure or uncertain write.
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		})().catch((error: unknown) => `Source undo connection ended before ${boundary}: ${String(error)}`);
		await Promise.race([
			expect.poll(() => readFile(reached, "utf8").catch(() => ""), { timeout: 15000 }).toBe("ready"),
			pending.then((diagnostic) => {
				throw new Error(diagnostic);
			}),
		]);
		if (boundary === "page-journal") expect(undoKey).not.toBe("crash-undo-0");
		if (boundary === "app-accepted")
			expect(await fixture.sql("SELECT phase FROM cutover", "boot.db")).toEqual([{ phase: "accepted" }]);
		else
			expect(await fixture.sql("SELECT state FROM source_batches WHERE state='publishing'", "boot.db")).toEqual([
				{ state: "publishing" },
			]);
		await app.stop("SIGKILL");
		await pending;
		await rm(armed);
		const resumed = await fixture.launch();
		await resumed.ready(cookie);
		expect(await readFile(join(fixture.root, path), "utf8")).toBe("before");
		const first = await (await resumed.post("/api/revert", { path }, cookie, undoKey)).json();
		expect(first).toMatchObject(boundary === "app-accepted" ? { status: "live" } : { published: true });
		expect((await put(resumed.url, "later edit")).status).toBe(200);
		const generations = await fixture.sql("SELECT n FROM generations", "boot.db");
		const versions = await fixture.sql("SELECT id FROM versions", "boot.db");
		expect(await (await resumed.post("/api/revert", { path }, cookie, undoKey)).json()).toEqual(first);
		expect(await readFile(join(fixture.root, path), "utf8")).toBe("later edit");
		expect(await fixture.sql("SELECT n FROM generations", "boot.db")).toEqual(generations);
		expect(await fixture.sql("SELECT id FROM versions", "boot.db")).toEqual(versions);
	},
);
