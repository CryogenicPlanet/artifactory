import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect } from "vitest";
import { sourcePut } from "./source-put.ts";

type Evidence = {
	readonly selected: string;
	readonly settings: readonly { readonly key: string; readonly value: string }[];
	readonly migrationState?: unknown;
	readonly evidence: unknown;
};
type Running = {
	readonly child: ChildProcess;
	readonly url: string;
	readonly state: (cookie: string, desired: string, timeout?: number) => Promise<void>;
	readonly post: (path: string, body: unknown, cookie?: string, headers?: Record<string, string>) => Promise<Response>;
};
/** Real source publication, rehearsal and pre-flip restore, using the existing authenticated repair board. */
export const remoteMigrationChain = async (fixture: {
	readonly launch: () => Promise<Running>;
	readonly root: string;
	readonly stop: (child: ChildProcess) => Promise<void>;
	readonly operator: (action: string) => Promise<Evidence>;
	readonly before: Evidence;
	readonly cookie: string;
	readonly input: { readonly topic: string; readonly body: string };
	readonly key: string;
	readonly message: { readonly id: string; readonly body: string; readonly seq: number };
}) => {
	const { cookie, input, key, message } = fixture;
	const migration = (body: string) => `import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; ${body} });`;
	for (const stage of ["rehearsal", "candidate"] as const) {
		const running = await fixture.launch();
		await running.state(cookie, "live");
		expect((await running.post("/api/lock", {}, cookie)).status).toBe(200);
		const put = async (file: string, body: string) => {
			const response = await sourcePut(`${running.url}/api/fs/app/migrations/${file}?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: migration(body),
			});
			expect(response.status).toBe(200);
		};
		await put(
			"900_chain_first.ts",
			"yield* sql`CREATE TABLE migration_chain_first(value TEXT)`; yield* sql`INSERT INTO migration_chain_first VALUES('first committed DDL')`;",
		);
		await put(
			"901_chain_second.ts",
			`const first = yield* sql\`SELECT value FROM migration_chain_first\`; if(first.length !== 1 || first[0]?.value !== "first committed DDL") return yield* Effect.die("first migration missing"); yield* sql\`CREATE TABLE migration_chain_second(value TEXT)\`; if(process.env.STATE === "${stage}") { yield* (yield* FileSystem.FileSystem).writeFileString(${JSON.stringify(join(fixture.root, `migration-${stage}-executed`))}, "first row verified; second DDL executed"); return yield* Effect.die("native ${stage} mid-batch sentinel"); }`,
		);
		const response = await running.post("/api/reload", {}, cookie);
		expect(await response.json()).toMatchObject({ status: "failed" });
		await running.state(cookie, "live", 90000);
		expect(await (await running.post("/api/messages", input, cookie, { "idempotency-key": key })).json()).toMatchObject(
			message,
		);
		await fixture.stop(running.child);
		const evidence = await fixture.operator("inspect");
		expect(await readFile(join(fixture.root, `migration-${stage}-executed`), "utf8")).toBe(
			"first row verified; second DDL executed",
		);
		expect(evidence.migrationState).toEqual({ ledger: [], tables: [] });
		expect(evidence.settings.find((row) => row.key === "app_store_id")).toEqual(
			fixture.before.settings.find((row) => row.key === "app_store_id"),
		);
		expect(evidence.evidence).toMatchObject({
			identity: [{ store_id: fixture.before.settings.find((row) => row.key === "app_store_id")?.value }],
		});
		if (stage === "rehearsal") expect(evidence.selected).toBe(fixture.before.selected);
		else expect(evidence.selected).not.toBe(fixture.before.selected);
	}
	const recovered = await fixture.launch();
	await recovered.state(cookie, "live");
	expect(
		(await recovered.post("/api/messages", { topic: input.topic, body: "After migration rollback" }, cookie)).status,
	).toBe(200);
	await fixture.stop(recovered.child);
	const restarted = await fixture.launch();
	await restarted.state(cookie, "live");
	expect(await (await restarted.post("/api/messages", input, cookie, { "idempotency-key": key })).json()).toMatchObject(
		message,
	);
	const rows: unknown = await (
		await fetch(`${restarted.url}/api/messages?since=0&topic=repair`, { headers: { cookie } })
	).json();
	expect(rows).toMatchObject({ items: [{ body: input.body }, { body: "After migration rollback" }] });
	await fixture.stop(restarted.child);
};
