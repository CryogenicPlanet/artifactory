import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function launch(test: TestContext, mode: "resistant" | "hung", denyProbe = false) {
	const root = await mkdtemp(join(tmpdir(), "comms-child-descendants-"));
	const receipt = join(root, "closed");
	const attempt = randomUUID();
	const entry = join(import.meta.dirname, "../src/child-keeper.ts");
	const preload = join(root, "deny-probe.ts");
	if (denyProbe)
		await writeFile(
			preload,
			`const original = process.kill.bind(process); process.kill = (pid, signal) => { if (pid < 0 && signal === 0) {const error = new Error("probe denied"); error.code="EPERM"; throw error;} return original(pid,signal);};`,
		);
	// This disposable lease owner is killed abruptly to reproduce boot death.
	const owner = spawn(
		"bun",
		[
			"-e",
			`import {spawn} from "node:child_process";
const keeper = spawn(process.execPath, JSON.parse(process.env.KEEPER_ARGS), {env: {COMMS_CHILD_CONFIG: process.env.COMMS_CHILD_CONFIG}, stdio:["pipe","inherit","inherit"]});
console.log("KEEPER_PID="+keeper.pid); keeper.on("exit",code=>process.exit(code??1));`,
		],
		{
			env: {
				PATH: process.env.PATH,
				KEEPER_ARGS: JSON.stringify([...(denyProbe ? ["--preload", preload] : []), entry]),
				COMMS_CHILD_CONFIG: JSON.stringify({
					entry: join(import.meta.dirname, "fixtures/child-descendant.ts"),
					cwd: root,
					env: { DESCENDANT_DIRECTORY: root, DESCENDANT_MODE: mode },
					receipt,
					attempt,
				}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16384);
	};
	owner.stdout.on("data", capture);
	owner.stderr.on("data", capture);
	let pids: number[] = [];
	test.onTestFinished(async () => {
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
		const keeper = /KEEPER_PID=(\d+)/.exec(output)?.[1];
		for (const pid of [...pids, ...(keeper ? [Number(keeper)] : [])]) {
			if (alive(pid)) process.kill(pid, "SIGKILL");
		}
		await expect.poll(() => pids.every((pid) => !alive(pid)), { timeout: 5000 }).toBe(true);
		await rm(root, { recursive: true, force: true });
	});
	await expect.poll(() => output, { timeout: 5000 }).toContain("DESCENDANT_READY");
	const values: unknown = JSON.parse(await readFile(join(root, "pids"), "utf8"));
	if (!Array.isArray(values) || !values.every((value): value is number => typeof value === "number"))
		throw new Error("Invalid owned process ids");
	pids = values;
	const execute = promisify(execFile);
	const writes = async () => {
		const { stdout } = await execute("bun", [
			"-e",
			`import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); console.log(db.query("SELECT n FROM writes").get().n); db.close();`,
			join(root, "writes.db"),
		]);
		return Number(stdout.trim());
	};
	return {
		root,
		owner,
		receipt,
		attempt,
		pids,
		writes,
		output: () => output,
		async closed() {
			await expect.poll(async () => readFile(receipt, "utf8").catch(() => output), { timeout: 7000 }).toBe(attempt);
			const count = await writes();
			await delay(100);
			expect(await writes()).toBe(count);
			expect(
				pids.every((pid) => !alive(pid)),
				output,
			).toBe(true);
		},
	};
}

it("closes resistant database-writing descendants before receipting a successful leader exit", async (test) => {
	const run = await launch(test, "resistant");
	const before = await run.writes();
	await expect.poll(run.writes).toBeGreaterThan(before);
	await writeFile(join(run.root, "exit-leader"), "exit");
	await run.closed();
}, 12000);

for (const mode of ["resistant", "hung"] as const) {
	it(`closes the ${mode} app group after abrupt boot lease-owner death`, async (test) => {
		const run = await launch(test, mode);
		expect(await run.writes()).toBeGreaterThan(0);
		run.owner.kill("SIGKILL");
		await run.closed();
	}, 12000);
}

it("withholds the closure receipt when the process-group probe is denied", async (test) => {
	const run = await launch(test, "resistant", true);
	await writeFile(join(run.root, "exit-leader"), "exit");
	await expect.poll(() => run.owner.exitCode, { timeout: 7000 }).toBe(1);
	await expect(readFile(run.receipt)).rejects.toMatchObject({ code: "ENOENT" });
	expect(run.output()).toContain("Child group closure could not be verified");
}, 12000);
