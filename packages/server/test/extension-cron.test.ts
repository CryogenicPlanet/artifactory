import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);

it("runs cron only in live scopes, resumes after freeze, and isolates a failed job", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-cron-test-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "ext");
	await mkdir(directory);
	await symlink(join(import.meta.dirname, "../node_modules"), join(root, "node_modules"));
	await writeFile(
		join(directory, "healthy.ts"),
		`import {Console} from "effect";
export default api => {
 api.cron("* * * * *", ctx => Console.log("tick:" + ctx.scheduledAt));
 api.on("shutdown", () => Console.log("healthy:stop"));
}`,
	);
	await writeFile(
		join(directory, "failed.ts"),
		`import {Console,Effect} from "effect";
export default api => {
 api.cron("* * * * *", () => Effect.die("scheduled failure"));
 api.cron("*/2 * * * *", () => Console.log("unexpected sibling"));
 api.on("shutdown", () => Console.log("failed:stop"));
}`,
	);
	await writeFile(join(directory, "invalid.ts"), 'export default api => api.cron("bad", async () => {});');
	const { stdout } = await execute("bun", [join(import.meta.dirname, "fixtures/extension-cron.ts")], {
		env: { ...process.env, EXTENSION_DIRECTORY: directory },
	});
	const lines = stdout.trim().split("\n");
	const result = JSON.parse(lines.pop() ?? "null");
	expect(lines.filter((line) => line.startsWith("tick:"))).toEqual(["tick:420000", "tick:480000", "tick:720000"]);
	expect(lines.filter((line) => line === "healthy:stop")).toHaveLength(2);
	expect(lines.filter((line) => line === "failed:stop")).toHaveLength(1);
	expect(lines).not.toContain("unexpected sibling");
	expect(result.status).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "failed.ts",
				status: "disabled",
				error: expect.stringContaining("scheduled failure"),
			}),
			expect.objectContaining({ name: "invalid.ts", status: "disabled" }),
			expect.objectContaining({ name: "healthy.ts", status: "loaded", cron: ["* * * * *"] }),
		]),
	);
	expect(result.diagnostics.filter((item: { type: string }) => item.type === "cron.ran")).toHaveLength(3);
});

it("waits for an already running Promise job before acknowledging frozen", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "comms-cron-promise-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "ext");
	await mkdir(directory);
	await symlink(join(import.meta.dirname, "../node_modules"), join(root, "node_modules"));
	await writeFile(
		join(directory, "promise.ts"),
		`import {Console,Effect} from "effect";
export default api => {
 api.cron("* * * * *", async ctx => {
   console.log("begin:" + ctx.scheduledAt);
   await Effect.runPromise(Effect.sleep("30 millis"));
   console.log("end:" + ctx.scheduledAt);
 });
 api.on("shutdown", () => Console.log("stop"));
}`,
	);
	await writeFile(
		join(directory, "zz-later.ts"),
		`import {Console} from "effect";
export default api => api.cron("9 * * * *", () => Console.log("unexpected post-freeze job"));`,
	);
	const { stdout } = await execute("bun", [join(import.meta.dirname, "fixtures/extension-cron.ts")], {
		env: { ...process.env, EXTENSION_DIRECTORY: directory },
	});
	const lines = stdout.trim().split("\n");
	const result = JSON.parse(lines.pop() ?? "null");
	expect(result.diagnostics.filter((item: { type: string }) => item.type === "cron.ran")).toHaveLength(2);
	expect(lines).toEqual(["begin:420000", "end:420000", "stop", "begin:720000", "end:720000", "stop"]);
});
