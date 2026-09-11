import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { TestContext } from "vitest";

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function launch(test: TestContext, mode: "normal" | "resistant" | "hung") {
	const root = await mkdtemp(join(tmpdir(), "comms-keeper-"));
	const entry = join(root, "child.ts");
	const receipt = join(root, "closed");
	const attempt = randomUUID();
	await writeFile(
		entry,
		`if (process.env.COMMS_CHILD_CONFIG) throw new Error("keeper environment leaked");
process.on("SIGTERM", () => {});
console.log("APP_READY");
if (process.env.MODE === "normal") setTimeout(() => process.exit(0), 250);
else if (process.env.MODE === "hung") { while (true) {} }
else setInterval(() => {}, 1000);
`,
	);
	const keeper = spawn("bun", [join(import.meta.dirname, "../src/child-keeper.ts")], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			COMMS_CHILD_CONFIG: JSON.stringify({
				entry,
				cwd: root,
				env: { MODE: mode },
				receipt,
				attempt,
			}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16384);
	};
	keeper.stdout.on("data", capture);
	keeper.stderr.on("data", capture);
	const exited = () => keeper.exitCode !== null || keeper.signalCode !== null;
	let childPid: number | undefined;
	test.onTestFinished(async () => {
		// This test owns the process identities, including the orphan deliberately made below.
		if (!exited()) keeper.kill("SIGKILL");
		if (childPid !== undefined && alive(childPid)) process.kill(childPid, "SIGKILL");
		await expect.poll(() => exited(), { timeout: 5000 }).toBe(true);
		if (childPid !== undefined) {
			const pid = childPid;
			await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
		}
		await rm(root, { recursive: true, force: true });
	});
	await expect.poll(() => output, { timeout: 5000 }).toContain("APP_READY");
	const match = output.match(/COMMS_CHILD_PID=(\d+)/);
	if (!match?.[1]) throw new Error(`Keeper did not announce child: ${output}`);
	const pid = Number(match[1]);
	childPid = pid;
	return {
		keeper,
		receipt,
		attempt,
		childPid: pid,
		async closed() {
			await expect.poll(() => exited(), { timeout: 7000 }).toBe(true);
			expect(await readFile(receipt, "utf8")).toBe(attempt);
			expect((await stat(receipt)).mode & 0o777).toBe(0o600);
			expect(alive(pid)).toBe(false);
		},
	};
}

describe("immutable child keeper", () => {
	it("exits after the child exits even while the parent lease remains open", async (test) => {
		const child = await launch(test, "normal");
		await child.closed();
		expect(child.keeper.stdin.writableEnded).toBe(false);
	});

	for (const mode of ["resistant", "hung"] as const) {
		it(`closes a ${mode} child after parent pipe EOF`, async (test) => {
			const child = await launch(test, mode);
			child.keeper.stdin.end();
			await child.closed();
		});
	}

	it("finishes child cleanup before acknowledging keeper termination", async (test) => {
		const child = await launch(test, "resistant");
		child.keeper.kill("SIGTERM");
		await child.closed();
	});

	it("never produces closure proof when the keeper is killed before cleanup", async (test) => {
		const child = await launch(test, "resistant");
		child.keeper.kill("SIGKILL");
		await expect.poll(() => child.keeper.signalCode, { timeout: 5000 }).toBe("SIGKILL");
		await delay(50);
		await expect(readFile(child.receipt)).rejects.toMatchObject({ code: "ENOENT" });
		expect(alive(child.childPid)).toBe(true);
	});
});
