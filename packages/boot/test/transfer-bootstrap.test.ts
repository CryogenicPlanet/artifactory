import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Opt-in, disposable native families: bootstrap-create2, bootstrap-insert2, bootstrap-positive.
// Reprovision these dedicated databases before rerunning; retained rows are crash evidence.
// COMMS_TRANSFER_HISTORICAL_ROOT must be a clean 50122ca checkout with frozen dependencies.
const execute = promisify(execFile);
const fixtures = join(import.meta.dirname, "fixtures");

for (const phase of ["create", "insert"] as const) {
	it.skipIf(!process.env.COMMS_TRANSFER_BOOTSTRAP_CONFIG_DIR || !process.env.COMMS_TRANSFER_HISTORICAL_ROOT)(
		`historical boot refuses the MySQL transfer sentinel after ${phase} SIGKILL`,
		{ timeout: 60000 },
		async (test) => {
			const directory = process.env.COMMS_TRANSFER_BOOTSTRAP_CONFIG_DIR;
			const historical = process.env.COMMS_TRANSFER_HISTORICAL_ROOT;
			if (!directory || !historical) throw new Error("Missing isolated fixture configuration");
			expect((await execute("git", ["rev-parse", "HEAD"], { cwd: historical })).stdout.trim()).toBe(
				(await execute("git", ["rev-parse", "50122ca"], { cwd: historical })).stdout.trim(),
			);
			expect(
				(await execute("git", ["diff", "HEAD", "--", "packages", "bun.lock", "package.json"], { cwd: historical }))
					.stdout,
			).toBe("");
			await execute("bun", ["packages/server/stage-runtime.ts"], { cwd: historical });
			const local = await realpath(await mkdtemp("/tmp/comms-bootstrap-crash-"));
			let stopHistorical: (() => Promise<void>) | undefined;
			test.onTestFinished(async () => {
				await stopHistorical?.();
				await rm(local, { recursive: true, force: true });
			});
			const data = join(local, "data");
			await mkdir(data);
			const args = [directory, phase, data];
			const inspect = async () =>
				JSON.parse((await execute("bun", [join(fixtures, "transfer-bootstrap-inspect.ts"), ...args])).stdout);
			expect(await inspect()).toMatchObject({ tables: [], bootTables: [], identities: [] });
			const boot = join(local, "packages/boot");
			await cp(join(import.meta.dirname, "../src"), join(boot, "src"), { recursive: true });
			await mkdir(join(boot, "test/fixtures"), { recursive: true });
			for (const name of ["transfer-bootstrap-config.ts", "transfer-bootstrap-run.ts"])
				await cp(join(fixtures, name), join(boot, "test/fixtures", name));
			await symlink(join(import.meta.dirname, "../node_modules"), join(boot, "node_modules"));
			const target = join(boot, "src/transfer-sentinel.ts");
			const source = await readFile(target, "utf8");
			const needle =
				phase === "create" ? "yield* identity.run;" : "yield* assertTransferSentinel(app, selection, seed);";
			expect(source.split(needle)).toHaveLength(2);
			await writeFile(
				target,
				source.replace(
					needle,
					phase === "create"
						? `${needle}\nprocess.kill(process.pid, "SIGKILL");`
						: `process.kill(process.pid, "SIGKILL");\n${needle}`,
				),
			);
			await expect(
				execute("bun", [join(boot, "test/fixtures/transfer-bootstrap-run.ts"), ...args]),
			).rejects.toMatchObject({ signal: "SIGKILL" });
			const before = await inspect();
			expect(before).toMatchObject({ tables: [{ name: "store_identity" }], bootTables: [] });
			if (phase === "create") expect(before.identities).toEqual([]);
			else {
				expect(before.identities).toHaveLength(1);
				expect(before.identities[0].transferred_to).toEqual(expect.any(String));
			}
			const listener = createServer();
			await new Promise<void>((resolve, reject) => {
				listener.once("error", reject);
				listener.listen(0, "127.0.0.1", resolve);
			});
			const address = listener.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture listener address");
			const port = address.port;
			await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
			const child = spawn(
				"bun",
				[join(fixtures, "transfer-bootstrap-historical.ts"), ...args, historical, String(port)],
				{
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const exited = once(child, "exit");
			child.stdout.resume();
			child.stderr.resume();
			stopHistorical = async () => {
				const pid = Number(await readFile(join(data, "historical.pid"), "utf8"));
				expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
				const processes = (await execute("ps", ["-axo", "pid=,ppid=,pgid="])).stdout
					.trim()
					.split("\n")
					.map((line) => {
						const [id, parent, group] = line.trim().split(/\s+/).map(Number);
						return { id, parent, group };
					});
				const descendants = [pid];
				for (let index = 0; index < descendants.length; index++)
					for (const row of processes)
						if (row.parent === descendants[index] && row.id !== undefined && !descendants.includes(row.id))
							descendants.push(row.id);
				const groups = processes
					.filter((row) => row.id !== undefined && descendants.includes(row.id))
					.map((row) => row.group)
					.filter((group): group is number => group !== undefined && group > 0);
				expect(groups).toContain(pid);
				expect(descendants.length).toBeGreaterThan(1);
				await writeFile(join(data, "historical-processes.json"), JSON.stringify({ descendants, groups }), {
					mode: 0o600,
				});
				process.kill(pid, "SIGTERM");
				expect(
					await Promise.race([
						exited.then(() => true),
						new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
					]),
				).toBe(true);
				const absent = (id: number) => {
					try {
						process.kill(id, 0);
						return false;
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
						throw error;
					}
				};
				await expect
					.poll(() => descendants.every(absent) && groups.every((group) => absent(-group)), { timeout: 5000 })
					.toBe(true);
			};
			await expect
				.poll(async () => (await inspect()).generations, { timeout: 30000, interval: 500 })
				.toEqual(expect.arrayContaining([expect.objectContaining({ refused: 1 })]));
			const after = await inspect();
			expect(after.identities).toEqual(before.identities);
			expect(after.tables).toEqual(before.tables);
			expect(after.versions).toEqual([{ version: 19 }]);
			expect(after.generations).not.toEqual(expect.arrayContaining([expect.objectContaining({ good: 1 })]));
			expect(after.attempts).toEqual([]);
		},
	);
}

it.skipIf(!process.env.COMMS_TRANSFER_BOOTSTRAP_CONFIG_DIR)(
	"MySQL bootstrap prepares and re-enters the initialized transfer kernel",
	{ timeout: 60000 },
	async (test) => {
		const directory = process.env.COMMS_TRANSFER_BOOTSTRAP_CONFIG_DIR;
		if (!directory) throw new Error("Missing isolated fixture configuration");
		const local = await realpath(await mkdtemp("/tmp/comms-bootstrap-positive-"));
		test.onTestFinished(() => rm(local, { recursive: true, force: true }));
		const args = [directory, "positive", local];
		const before = JSON.parse(
			(await execute("bun", [join(fixtures, "transfer-bootstrap-inspect.ts"), ...args])).stdout,
		);
		expect(before).toMatchObject({ tables: [], bootTables: [], identities: [] });
		const result = await execute("bun", [join(fixtures, "transfer-bootstrap-run.ts"), ...args]);
		expect(result.stdout).toContain("NATIVE_BOOTSTRAP_READY_VERIFIED");
	},
);
