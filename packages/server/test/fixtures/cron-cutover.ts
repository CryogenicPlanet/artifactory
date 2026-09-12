import { cp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type TestContext } from "vitest";
import { conversation } from "./conversation.ts";

/** Real boot/child ownership with controlled ticks; calendar timing is tested separately. */
export async function cronCutover(test: TestContext) {
	const fixture = await conversation(test);
	const boot = join(fixture.root, "packages/boot");
	await cp(join(import.meta.dirname, "../../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	await cp(
		join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"),
		join(boot, "test/fixtures/launcher.ts"),
	);
	await symlink(join(import.meta.dirname, "../../../boot/node_modules"), join(boot, "node_modules"));
	const server = join(fixture.root, "packages/server/src");
	await cp(join(import.meta.dirname, "../../src"), server, { recursive: true });
	await symlink(join(import.meta.dirname, "../../node_modules"), join(server, "../node_modules"));
	const markers = join(fixture.root, "cron-markers");
	await mkdir(markers);
	await writeFile(join(markers, "tick"), "0");
	const extension = `import { appendFile, writeFile } from "node:fs/promises";
export default api => {
 api.on("start", ({reason}) => writeFile(${JSON.stringify(markers)} + "/start-" + process.pid + "-" + reason, "started"));
 api.cron("* * * * *", ({scheduledAt}) => appendFile(${JSON.stringify(markers)} + "/job-" + process.pid + "-" + scheduledAt, "ran\\n"));
};`;
	await writeFile(join(server, "ext/cron-owner.ts"), extension);
	// Only extension jobs use the clock. The app backup scheduler remains unchanged.
	const extPath = join(server, "kernel/ext.ts");
	const ext = await readFile(extPath, "utf8");
	const clockImport = 'import { parseCron, runCron } from "./extension-cron.ts";';
	expect(ext.split(clockImport)).toHaveLength(2);
	await writeFile(
		extPath,
		ext.replace(
			clockImport,
			'import { parseCron } from "./extension-cron.ts";\nimport { runCron } from "./controlled-cron.ts";',
		),
	);
	await writeFile(
		join(server, "kernel/controlled-cron.ts"),
		`import { Effect, FileSystem } from "effect";
export const runCron = (_schedule, run) => Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 const prefix = ${JSON.stringify(markers)};
 yield* fs.writeFileString(prefix + "/open-" + process.pid, "opened\\n", { flag: "a" });
 yield* Effect.addFinalizer(() => fs.writeFileString(prefix + "/closed-" + process.pid, "closed").pipe(Effect.orDie));
 let last = -1;
 while (true) {
  const tick = Number(yield* fs.readFileString(prefix + "/tick"));
  if (tick !== last) {
   yield* run(tick);
   yield* fs.writeFileString(prefix + "/ack-" + process.pid + "-" + tick, "completed");
   last = tick;
  }
  yield* Effect.sleep("10 millis");
 }
});`,
	);
	const cutoverPath = join(boot, "src/cutover.ts");
	let cutover = await readFile(cutoverPath, "utf8");
	const barrier = (name: string) => `
 yield* fs.writeFileString(${JSON.stringify(join(markers, name))}, String(candidate.process.pid));
 while (!(yield* fs.exists(${JSON.stringify(join(markers, name + "-release"))}))) yield* Effect.sleep("10 millis");
`;
	const health = '}).pipe(Effect.timeout("5 seconds"));';
	expect(cutover.split(health)).toHaveLength(2);
	cutover = cutover.replace(health, health + barrier("healthy"));
	const live = 'yield* activate(candidate, "live");';
	expect(cutover.split(live)).toHaveLength(2);
	cutover = cutover.replace(live, barrier("retired") + live);
	await writeFile(cutoverPath, cutover);
	return {
		...fixture,
		extension,
		launch: () => fixture.launch(join(server, "server.ts"), join(boot, "test/fixtures/launcher.ts")),
		markers: () => readdir(markers),
		read: (name: string) => readFile(join(markers, name), "utf8"),
		wait: async (name: string) => {
			await expect.poll(() => readFile(join(markers, name), "utf8").catch(() => ""), { timeout: 20000 }).not.toBe("");
			return readFile(join(markers, name), "utf8");
		},
		release: (name: string) => writeFile(join(markers, name + "-release"), "release"),
		tick: async (at: number) => {
			await writeFile(join(markers, "tick.tmp"), String(at));
			await rename(join(markers, "tick.tmp"), join(markers, "tick"));
		},
	};
}
