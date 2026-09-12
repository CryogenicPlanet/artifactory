// These account-closure fixtures require an exclusive role pair: run with --maxWorkers=1.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import { Schema } from "effect";
import { expect, it } from "vitest";

for (const mode of ["eof", "kill", "reject"])
	it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG || !process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
		`remote keeper proves account closure before receipt after ${mode}`,
		async (test) => {
			const root = await mkdtemp(join(tmpdir(), "comms-remote-keeper-"));
			test.onTestFinished(() => rm(root, { recursive: true, force: true }));
			const result = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/remote-keeper.ts"), root, mode],
				{ timeout: 25000 },
			);
			expect(result.stdout).toContain("REMOTE_KEEPER_VERIFIED");
		},
		30000,
	);

for (const mode of ["active", "delayed"])
	it.skipIf(!process.env.COMMS_REMOTE_TEST_CONFIG || !process.env.COMMS_REMOTE_BOOT_TEST_CONFIG)(
		`real app keeper survives boot worker SIGKILL and closes before reopen (${mode})`,
		async (test) => {
			const root = await mkdtemp(join(tmpdir(), "comms-remote-keeper-crash-"));
			const launcher = spawn("bun", [join(import.meta.dirname, "fixtures/remote-keeper-crash.ts"), root, mode], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			launcher.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			launcher.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const closed = once(launcher, "close");
			let ready: { readonly worker: number; readonly child: number; readonly root: string } | undefined;
			let verified = false;
			test.onTestFinished(async () => {
				if (!verified && ready) {
					for (const pid of [-ready.child, -ready.worker]) {
						try {
							process.kill(pid, "SIGKILL");
						} catch (error) {
							if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
						}
					}
				}
				if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
				await closed;
				await rm(root, { recursive: true, force: true });
			});
			await expect
				.poll(() => readFile(join(root, "ready.json"), "utf8").catch(() => ""), { timeout: 10000 })
				.not.toBe("");
			ready = Schema.decodeSync(
				Schema.fromJsonString(Schema.Struct({ worker: Schema.Int, child: Schema.Int, root: Schema.String })),
			)(await readFile(join(root, "ready.json"), "utf8"));
			expect(ready.worker).toBeGreaterThan(1);
			expect(ready.child).toBeGreaterThan(1);
			process.kill(ready.worker, "SIGKILL");
			if (mode === "delayed") {
				const admission = join(root, `remote-admission-${ready.root}.json`);
				await expect
					.poll(
						async () =>
							Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ state: Schema.String })))(
								await readFile(admission, "utf8"),
							).state,
						{ timeout: 5000 },
					)
					.not.toBe("open");
				const delayed = spawn("bun", [join(import.meta.dirname, "../src/child-keeper.ts")], {
					env: {
						PATH: process.env.PATH,
						COMMS_CHILD_CONFIG: await readFile(join(root, "delayed-config.json"), "utf8"),
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				let delayedOutput = "";
				delayed.stdout.on("data", (chunk: Buffer) => {
					delayedOutput += chunk.toString();
				});
				delayed.stderr.on("data", (chunk: Buffer) => {
					delayedOutput += chunk.toString();
				});
				const delayedClosed = once(delayed, "close");
				test.onTestFinished(async () => {
					if (delayed.exitCode === null && delayed.signalCode === null) delayed.kill("SIGKILL");
					await delayedClosed;
				});
				expect((await delayedClosed)[0]).not.toBe(0);
				output += delayedOutput;
				expect(delayedOutput).not.toContain("COMMS_CHILD_PID");
				expect(delayedOutput).not.toContain("REMOTE_CHILD_READY");
				await expect(readFile(join(root, "delayed-closed"))).rejects.toMatchObject({ code: "ENOENT" });
			}
			expect(
				(await closed)[0],
				output.match(/ROOT_(?:LAUNCH_RESULT|INVENTORY_RESULT|FAILURE_CODES|RECOVERY_CODES)=[a-zA-Z _,]+/g)?.join(", "),
			).toBe(0);
			expect(output).toContain("ROOT_KEEPER_CLOSURE_VERIFIED");
			let absent = false;
			try {
				process.kill(-ready.child, 0);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH") absent = true;
				else throw error;
			}
			expect(absent).toBe(true);
			for (const filename of [process.env.COMMS_REMOTE_TEST_CONFIG, process.env.COMMS_REMOTE_BOOT_TEST_CONFIG]) {
				if (!filename) throw new Error("Missing protected configuration");
				const encoded = await readFile(filename, "utf8");
				let password: string;
				try {
					password = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ password: Schema.String })))(
						encoded,
					).password;
				} catch {
					throw new Error("Invalid protected configuration");
				}
				expect(output.includes(password)).toBe(false);
			}
			expect(await readFile(join(root, "closed"), "utf8")).toBe("e8".repeat(32));
			if (mode === "delayed") {
				const owner = Schema.decodeSync(
					Schema.fromJsonString(
						Schema.Struct({
							state: Schema.String,
							inspector: Schema.NullOr(Schema.Unknown),
							sessions: Schema.Array(Schema.Unknown),
						}),
					),
				)(await readFile(join(root, "remote-owners", `${"e9".repeat(32)}.json`), "utf8"));
				expect(owner).toEqual({ state: "never-opened", inspector: null, sessions: [] });
			}
			const reopened = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/remote-runtime.ts"), root],
				{ timeout: 20000, env: { ...process.env, GUARDIAN_ASSERT_APP_CLOSED: "true" } },
			);
			expect(reopened.stdout).toContain("REMOTE_RUNTIME_VERIFIED");
			verified = true;
		},
		45000,
	);
