import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
const execute = promisify(execFile);
const Output = Schema.Struct({
	result: Schema.String,
	error: Schema.Unknown,
	journal: Schema.Array(Schema.Unknown),
	copied: Schema.Unknown,
	destination: Schema.Boolean,
	original: Schema.Unknown,
});
async function fixture(test: TestContext, blocked = false) {
	const root = await mkdtemp(join(tmpdir(), "comms-sqlite-copy-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	let script = join(import.meta.dirname, "fixtures/sqlite-copy.ts");
	if (blocked) {
		const boot = join(root, "packages/boot");
		await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
		await mkdir(join(boot, "test/fixtures"), { recursive: true });
		const copy = join(boot, "test/fixtures/sqlite-copy.ts");
		await cp(script, copy);
		script = copy;
		await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
		const worker = join(boot, "src/sqlite-copy-worker.ts");
		const text = await readFile(worker, "utf8");
		const needle = "yield* sql`VACUUM INTO ${config.destination}`;";
		expect(text.split(needle)).toHaveLength(2);
		await writeFile(
			worker,
			text.replace(
				needle,
				`${needle}\nyield* fs.writeFileString(${JSON.stringify(join(root, "worker.pid"))},String(process.pid));\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
			),
		);
		const keeper = join(boot, "src/sqlite-copy-keeper.ts");
		const keeperText = await readFile(keeper, "utf8");
		const keeperNeedle = "const result = yield* Effect.raceFirst";
		expect(keeperText.split(keeperNeedle)).toHaveLength(2);
		await writeFile(
			keeper,
			keeperText.replace(
				keeperNeedle,
				`yield* fs.writeFileString(${JSON.stringify(join(root, "keeper.pid"))},String(process.pid));\n${keeperNeedle}`,
			),
		);
	}
	const run = async (mode: string, budget = "30 seconds") =>
		Schema.decodeUnknownSync(Output)(
			Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
				(await execute("bun", [script, root, mode], { env: { ...process.env, REHEARSAL_COPY_BUDGET: budget } })).stdout,
			),
		);
	const pid = async (kind: string) => {
		let value = 0;
		await expect
			.poll(
				async () => {
					value = Number(await readFile(join(root, `${kind}.pid`), "utf8").catch(() => "0"));
					return value;
				},
				{ timeout: 5000 },
			)
			.toBeGreaterThan(0);
		test.onTestFinished(() => {
			try {
				process.kill(value, "SIGKILL");
			} catch {}
		});
		return value;
	};
	return { root, script, run, pid };
}
it("copies committed WAL data through an independently closed immutable worker", async (test) => {
	const app = await fixture(test);
	expect(await app.run("copy")).toMatchObject({
		result: "Success",
		journal: [],
		copied: [{ value: "acknowledged WAL write" }],
		original: [{ value: "acknowledged WAL write" }],
	});
});
it("times out a blocked SQLite owner, proves exit and removes only its unfinished copy", async (test) => {
	const app = await fixture(test, true);
	const result = app.run("copy", "1 second");
	const worker = await app.pid("worker");
	expect(await result).toMatchObject({
		result: "Failure",
		error: { code: "rehearsal_copy_timeout" },
		journal: [],
		destination: false,
		original: [{ value: "acknowledged WAL write" }],
	});
	expect(() => process.kill(worker, 0)).toThrow();
});
it("closes the worker after boot SIGKILL before restart cleans the copy intent", async (test) => {
	const app = await fixture(test, true);
	const child = spawn("bun", [app.script, app.root, "copy"], {
		env: { ...process.env, REHEARSAL_COPY_BUDGET: "30 seconds" },
		stdio: "ignore",
	});
	test.onTestFinished(() => {
		child.kill("SIGKILL");
	});
	const worker = await app.pid("worker");
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	expect(await app.run("recover")).toMatchObject({
		result: "Success",
		journal: [],
		destination: false,
		original: [{ value: "acknowledged WAL write" }],
	});
	expect(() => process.kill(worker, 0)).toThrow();
});
it("preserves the copy and journal when its keeper dies without closure proof", async (test) => {
	const app = await fixture(test, true);
	const result = app.run("copy");
	const worker = await app.pid("worker");
	process.kill(await app.pid("keeper"), "SIGKILL");
	expect(await result).toMatchObject({
		result: "Failure",
		error: { code: "sqlite_copy_closure_unproven" },
		destination: true,
	});
	expect(process.kill(worker, 0)).toBe(true);
	const recovering = await app.run("recover");
	expect(recovering).toMatchObject({
		result: "Failure",
		error: { code: "sqlite_copy_closure_unproven" },
		destination: true,
		original: [{ value: "acknowledged WAL write" }],
	});
	expect(recovering.journal).toHaveLength(1);
}, 15000);

it("waits for keeper closure when the calling Effect is interrupted", async (test) => {
	const app = await fixture(test, true);
	const result = app.run("interrupt");
	const worker = await app.pid("worker");
	expect(await result).toMatchObject({
		result: "Failure",
		journal: [],
		destination: false,
		original: [{ value: "acknowledged WAL write" }],
	});
	expect(() => process.kill(worker, 0)).toThrow();
});

it("stamps copy recovery as version19 so an image supporting18 refuses before opening the app", async (test) => {
	const app = await fixture(test, true);
	expect(await app.run("recover")).toMatchObject({ result: "Success" });
	const schema = join(app.root, "packages/boot/src/boot-schema.ts");
	const source = await readFile(schema, "utf8");
	expect(source.split("const supported = 19;")).toHaveLength(2);
	await writeFile(schema, source.replace("const supported = 19;", "const supported = 18;"));
	const before = await readFile(join(app.root, "app.db"));
	expect(await app.run("schema")).toMatchObject({ result: "Failure", error: { _tag: "BootSchemaTooNew" } });
	expect(await readFile(join(app.root, "app.db"))).toEqual(before);
});
