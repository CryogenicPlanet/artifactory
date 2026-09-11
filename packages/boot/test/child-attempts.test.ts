import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { TestContext } from "vitest";

const firstBoot = "12345678-1234-4234-8234-123456789abc";
const nextBoot = "87654321-4321-4321-8321-abcdef123456";
const Reservation = Schema.Struct({ id: Schema.String, receipt: Schema.String });

async function directory(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-attempts-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function execute(root: string, input: unknown) {
	const result = await promisify(execFile)("bun", [
		join(import.meta.dirname, "fixtures/child-attempts.ts"),
		root,
		JSON.stringify(input),
	]);
	const value: unknown = JSON.parse(result.stdout);
	return value;
}

describe("durable child ownership across kernel lifetimes", () => {
	it("persists kernel identity before opening and recovers after a changed kernel across real process loss", async (test) => {
		const root = await directory(test);
		const processHandle = spawn(
			"bun",
			[
				join(import.meta.dirname, "fixtures/child-attempts.ts"),
				root,
				JSON.stringify({ op: "crash", bootId: firstBoot }),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const exited = once(processHandle, "exit");
		test.onTestFinished(async () => {
			if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
			await exited;
		});
		let output = "";
		processHandle.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		await expect.poll(() => output, { timeout: 5000 }).toContain("beforeOpen");
		const reserved: unknown = JSON.parse(output);
		expect(reserved).toMatchObject({ beforeOpen: [{ boot_id: firstBoot, opened: 0 }] });
		processHandle.kill("SIGKILL");
		await exited;
		expect(await execute(root, { op: "recover", bootId: firstBoot })).toMatchObject({
			result: "Failure",
			error: expect.stringContaining("child_closure_unproven"),
			rows: [{ closed: 0 }],
		});
		expect(await execute(root, { op: "recover", bootId: nextBoot })).toMatchObject({
			result: "Success",
			rows: [{ boot_id: firstBoot, opened: 1, closed: 1 }],
		});
		expect(await execute(root, { op: "recover", bootId: nextBoot })).toMatchObject({
			result: "Success",
			rows: [{ closed: 1 }],
		});
	});

	it("never treats same, missing or malformed current/recorded identity as closure", async (test) => {
		for (const pair of [
			[firstBoot, firstBoot],
			[firstBoot, null],
			[null, nextBoot],
			["bad", nextBoot],
			[firstBoot, "bad"],
			["", nextBoot],
			[firstBoot, ""],
		]) {
			const root = await directory(test);
			expect(await execute(root, { op: "reserve", bootId: pair[0] })).toMatchObject({ beforeOpen: [{ opened: 0 }] });
			expect(await execute(root, { op: "recover", bootId: pair[1] })).toMatchObject({
				result: "Failure",
				rows: [{ closed: 0 }],
			});
		}
	});

	it("does not trust malformed stored evidence even with a valid new kernel", async (test) => {
		const root = await directory(test);
		await execute(root, { op: "reserve", bootId: firstBoot, storedId: "corrupt" });
		expect(await execute(root, { op: "recover", bootId: nextBoot })).toMatchObject({
			result: "Failure",
			rows: [{ closed: 0 }],
		});
	});

	it("still accepts a valid receipt without kernel identity and refuses incorrect receipt bytes", async (test) => {
		const root = await directory(test);
		const reserved = Schema.decodeUnknownSync(Reservation)(await execute(root, { op: "reserve", bootId: null }));
		await writeFile(reserved.receipt, "wrong");
		expect(await execute(root, { op: "recover", bootId: null })).toMatchObject({
			result: "Failure",
			rows: [{ closed: 0 }],
		});
		await writeFile(reserved.receipt, reserved.id);
		expect(await execute(root, { op: "recover", bootId: null })).toMatchObject({
			result: "Success",
			rows: [{ closed: 1 }],
		});
	});

	it("migrates legacy attempts to unknown identity and requires their existing receipt", async (test) => {
		const root = await directory(test);
		await execute(root, { op: "legacy", bootId: firstBoot });
		expect(await execute(root, { op: "recover", bootId: nextBoot })).toMatchObject({
			result: "Failure",
			version: [{ user_version: 12 }],
			rows: [{ id: "legacy", boot_id: null, closed: 0 }],
		});
		await writeFile(join(root, "attempts/legacy.closed"), "legacy");
		expect(await execute(root, { op: "recover", bootId: nextBoot })).toMatchObject({
			result: "Success",
			rows: [{ id: "legacy", closed: 1 }],
		});
	});
});
