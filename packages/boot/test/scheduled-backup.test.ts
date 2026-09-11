import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, type TestContext } from "vitest";

async function run(test: TestContext, mode: string) {
	const root = await mkdtemp(join(tmpdir(), "comms-scheduled-backup-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/scheduled-backup.ts"),
		root,
		mode,
	]);
	const value: unknown = JSON.parse(result.stdout);
	return value;
}

describe("on-demand quiesced backups", () => {
	it.for(["restore", "move", "source"])(
		"refuses pending %s recovery before touching traffic or the child",
		async (mode, test) => {
			expect(await run(test, mode)).toMatchObject({
				outcome: "Failure",
				calls: [],
				rows: [],
				current: "original",
				traffic: { frozen: false },
			});
		},
	);

	it("rejects a stale requesting epoch after waiting for another operation", async (test) => {
		expect(await run(test, "stale-request")).toMatchObject({
			outcome: "Failure",
			calls: [],
			rows: [],
			current: "replacement",
			traffic: { frozen: false },
		});
	});
	it("rechecks authorization after waiting for another operation", async (test) => {
		expect(await run(test, "revoked-request")).toMatchObject({
			outcome: "Failure",
			calls: [],
			rows: [],
			current: "original",
			traffic: { frozen: false },
		});
	});
	it("drains an admitted WAL write and reconciles publication before capture without restarting", async (test) => {
		expect(await run(test, "success")).toMatchObject({
			outcome: "Success",
			calls: ["frozen", "live"],
			rows: [{ reason: "hourly", generation: 1, published_through: 2 }],
			saved: { records: [{ value: "acknowledged WAL write" }], epoch: { epoch: "original" } },
			epoch: { epoch: "original" },
			current: "original",
			traffic: { frozen: false, admitted: 0 },
		});
	});
	it("requires keeper retirement before recovering an unacknowledged freeze", async (test) => {
		expect(await run(test, "freeze-failure")).toMatchObject({
			outcome: "Success",
			calls: ["frozen", "retire", "restart"],
			saved: { records: [{ value: "acknowledged WAL write" }], epoch: { epoch: "original" } },
			epoch: { epoch: "restarted" },
			current: "restarted",
			traffic: { frozen: false },
		});
	});
	it("releases unavailable traffic after a proven closed failed restart and removes its stale route", async (test) => {
		expect(await run(test, "restart-failure")).toMatchObject({
			outcome: "Failure",
			calls: ["frozen", "retire", "restart"],
			current: null,
			route: null,
			traffic: { frozen: false },
		});
	});
	it("leaves traffic frozen and never restarts after missing closure proof", async (test) => {
		expect(await run(test, "closure-failure")).toMatchObject({
			outcome: "Failure",
			calls: ["frozen", "retire"],
			rows: [],
			current: null,
			traffic: { frozen: true },
		});
	});
	it("releases traffic and resumes the same child when the backup budget refuses capture", async (test) => {
		expect(await run(test, "quota-refusal")).toMatchObject({
			outcome: "Failure",
			quotaError: "backup_budget",
			calls: ["frozen", "live"],
			cloneCalls: 0,
			rows: [],
			files: [],
			sameChild: true,
			current: "original",
			epoch: { epoch: "original" },
			traffic: { frozen: false, admitted: 0 },
		});
	});
	it("resumes the same child and cleans an unregistered copy after clone failure", async (test) => {
		expect(await run(test, "clone-failure")).toMatchObject({
			outcome: "Failure",
			calls: ["frozen", "live"],
			rows: [],
			files: [],
			current: "original",
			traffic: { frozen: false },
		});
	});
	it("rolls back metadata when the backup event cannot commit and removes the orphan", async (test) => {
		expect(await run(test, "registration-failure")).toMatchObject({
			outcome: "Failure",
			calls: ["frozen", "live"],
			rows: [],
			files: [],
			current: "original",
			traffic: { frozen: false },
		});
	});
	it("refuses an unfinished cutover before touching traffic or the child", async (test) => {
		expect(await run(test, "cutover")).toMatchObject({
			outcome: "Failure",
			calls: [],
			rows: [],
			current: "original",
			traffic: { frozen: false },
		});
	});
	it("finishes live restoration and orphan cleanup when the capture caller is interrupted", async (test) => {
		expect(await run(test, "interrupt")).toMatchObject({
			outcome: "Failure",
			calls: ["frozen", "live"],
			rows: [],
			files: [],
			current: "original",
			traffic: { frozen: false },
		});
	});
	it("never resumes a child after reconciliation reports inconsistent durable evidence", async (test) => {
		expect(await run(test, "reconciliation-failure")).toMatchObject({
			outcome: "Failure",
			calls: ["frozen", "retire", "restart"],
			rows: [],
			current: null,
			traffic: { frozen: true },
		});
	});
});
