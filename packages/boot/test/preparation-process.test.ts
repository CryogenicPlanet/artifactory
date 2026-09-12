import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
async function build(test: TestContext, script: string, denyGroupProbe = false) {
	const root = await mkdtemp(join(tmpdir(), "comms-preparation-process-"));
	await mkdir(join(root, "node_modules/vite/bin"), { recursive: true });
	await mkdir(join(root, "ui"));
	await writeFile(join(root, "node_modules/vite/bin/vite.js"), script);
	const preload = join(root, "deny-probe.ts");
	if (denyGroupProbe)
		await writeFile(
			preload,
			`const original = process.kill.bind(process); process.kill = (pid, signal) => { if (pid < 0 && signal === 0) {const error = new Error("probe denied"); error.code="EPERM"; throw error;} return original(pid,signal);};`,
		);
	const keeper = spawn(
		"bun",
		[...(denyGroupProbe ? ["--preload", preload] : []), join(import.meta.dirname, "../src/preparation-keeper.ts")],
		{
			env: {
				PATH: process.env.PATH,
				COMMS_PREPARATION_CONFIG: JSON.stringify({ operation: "build", workspace: root, output: join(root, "board") }),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	keeper.stdout.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-16384);
	});
	keeper.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-16384);
	});
	test.onTestFinished(async () => {
		if (keeper.exitCode === null && keeper.signalCode === null) keeper.kill("SIGTERM");
		await expect.poll(() => keeper.exitCode !== null || keeper.signalCode !== null, { timeout: 7000 }).toBe(true);
		await rm(root, { recursive: true, force: true });
	});
	return { root, keeper, stderr: () => stderr };
}

describe("fixed preparation keeper", () => {
	it("reports a real failed build and does not pass keeper configuration to editable code", async (test) => {
		const run = await build(
			test,
			`if(process.env.COMMS_PREPARATION_CONFIG) throw new Error("configuration leaked"); console.error("bad vite configuration"); process.exit(7);`,
		);
		await expect.poll(() => run.keeper.exitCode, { timeout: 5000 }).toBe(1);
		expect(run.stderr()).toContain("bad vite configuration");
		expect(run.stderr()).not.toContain("configuration leaked");
	});

	it("fails a successful command when process-group closure cannot be established", async (test) => {
		const run = await build(test, `console.error("completed build");`, true);
		await expect.poll(() => run.keeper.exitCode, { timeout: 5000 }).toBe(1);
		expect(run.stderr()).toContain("preparation_group_probe_failed");
	});

	it("cleans resistant descendants after their build leader exits successfully", async (test) => {
		const run = await build(
			test,
			`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync('../pids',JSON.stringify([child.pid])); setTimeout(()=>process.exit(0),150);`,
		);
		await expect
			.poll(async () => readFile(join(run.root, "pids"), "utf8").catch(() => ""), { timeout: 5000 })
			.not.toBe("");
		const values: unknown = JSON.parse(await readFile(join(run.root, "pids"), "utf8"));
		if (!Array.isArray(values) || !values.every((value): value is number => typeof value === "number"))
			throw new Error("Invalid process ids");
		await expect.poll(() => run.keeper.exitCode, { timeout: 7000 }).not.toBe(null);
		expect(run.keeper.exitCode, run.stderr()).toBe(0);
		expect(values.every((pid) => !alive(pid))).toBe(true);
	}, 12000);

	it("kills a hung build and its ordinary descendant when the boot lease closes", async (test) => {
		const run = await build(
			test,
			`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync('../pids',JSON.stringify([process.pid,child.pid])); process.on('SIGTERM',()=>{}); while(true){}`,
		);
		await expect
			.poll(async () => readFile(join(run.root, "pids"), "utf8").catch(() => ""), { timeout: 5000 })
			.not.toBe("");
		const values: unknown = JSON.parse(await readFile(join(run.root, "pids"), "utf8"));
		if (!Array.isArray(values) || !values.every((value): value is number => typeof value === "number"))
			throw new Error("Invalid process ids");
		run.keeper.stdin.end();
		await expect.poll(() => values.every((pid) => !alive(pid)), { timeout: 7000 }).toBe(true);
	}, 12000);
});
