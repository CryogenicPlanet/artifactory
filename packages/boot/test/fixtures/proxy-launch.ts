import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Console, Effect } from "effect";
import { expect, type TestContext } from "vitest";
import { childDiagnostic, launcherOutput } from "./launcher-diagnostics.ts";
import { seedSession, sessionFetch } from "./session.ts";

export async function launch(test: TestContext, mode = "normal", actualServer = false) {
	const directory = await mkdtemp(join(tmpdir(), "comms-proxy-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const seed = join(directory, "seed");
	await mkdir(seed);
	await copyFile(join(import.meta.dirname, "child.ts"), join(seed, "fixture.ts"));
	const entry = join(seed, "child.ts");
	await writeFile(entry, `import { serve } from "./fixture.ts"; serve(${JSON.stringify(mode)});`);
	const processHandle = spawn("bun", [join(import.meta.dirname, "launcher.ts")], {
		env: {
			...process.env,
			ENTRY: actualServer ? join(import.meta.dirname, "../../../server/src/server.ts") : entry,
			DATA_DIR: join(directory, "data"),
			BOOT_DATABASE_URL: "must-not-reach-child",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let lastState: unknown = null;
	const started = performance.now();
	let beforeCleanup: { exit_code: number | null; signal: NodeJS.Signals | null } | null = null;
	test.onTestFailed(() => {
		Effect.runSync(
			Console.error("Boot proxy fixture diagnostic", {
				elapsed_ms: Math.round(performance.now() - started),
				before_cleanup: beforeCleanup,
				output: launcherOutput(output),
				child: childDiagnostic(lastState),
			}),
		);
	});
	processHandle.stdout.on("data", (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16384);
	});
	processHandle.stderr.on("data", (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16384);
	});
	test.onTestFinished(async () => {
		beforeCleanup = { exit_code: processHandle.exitCode, signal: processHandle.signalCode };
		if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
		const exited = once(processHandle, "exit");
		processHandle.kill("SIGTERM");
		await Promise.race([
			exited,
			delay(5000).then(() => {
				if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
			}),
		]);
		await exited;
	});
	let url = "";
	await expect
		.poll(
			() => {
				url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
				if (processHandle.exitCode !== null) throw new Error(JSON.stringify(launcherOutput(output)));
				return url;
			},
			{ timeout: 5000 },
		)
		.not.toBe("");
	const { cookie, id } = await seedSession(join(directory, "data"));
	const authenticatedFetch = sessionFetch(cookie);
	const state = async () => {
		const value: unknown = await (await authenticatedFetch(`${url}/_boot/status`)).json();
		if (typeof value !== "object" || value === null || !("child" in value)) throw new Error("Missing child state");
		const child = value.child;
		lastState = child;
		if (
			typeof child !== "object" ||
			child === null ||
			!("state" in child) ||
			!("stderr" in child) ||
			!("pid" in child) ||
			!("port" in child)
		)
			throw new Error("Invalid child state");
		return child;
	};
	return { url, state, processHandle, cookie, id, data: join(directory, "data"), fetch: authenticatedFetch };
}
