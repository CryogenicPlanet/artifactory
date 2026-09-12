import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import { expect, it } from "vitest";

const app = process.env.COMMS_CONCURRENCY_APP_CONFIG;
const boot = process.env.COMMS_CONCURRENCY_BOOT_CONFIG;

it.skipIf(!app || !boot)(
	"native processes reject stale epochs and serialize allocator and edit-lock contenders",
	async () => {
		if (!app || !boot) throw new Error("Missing native concurrency configuration");
		const children: ReturnType<typeof spawn>[] = [];
		const start = (mode: string, config: string, identity = "") => {
			const child = spawn(
				"bun",
				[`${import.meta.dirname}/../fixtures/native-concurrency-worker.ts`, mode, config, identity],
				{
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 25000,
					killSignal: "SIGKILL",
				},
			);
			children.push(child);
			if (!child.stdout || !child.stdin || !child.stderr) throw new Error("Missing child pipes");
			// Never forward arbitrary driver output or protected fixture configuration into test failures.
			child.stderr.resume();
			const lines = createInterface({ input: child.stdout });
			const iterator = lines[Symbol.asyncIterator]();
			const exited = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", resolve);
			});
			return {
				pid: child.pid,
				go: () => child.stdin?.write("go\n"),
				next: async () => {
					const line = await iterator.next();
					if (line.done) throw new Error(`Native ${mode} exited before its barrier`);
					return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(line.value);
				},
				finish: async () => {
					expect(await exited).toBe(0);
					lines.close();
				},
			};
		};
		const once = async (mode: string, config: string, identity = "") => {
			const child = start(mode, config, identity);
			expect(await child.next()).toEqual({ done: true });
			await child.finish();
		};
		try {
			await once("initialize", app);
			await once("initialize", boot);
			const current = start("fence", app, "current");
			const stale = start("fence", app, "stale");
			expect(current.pid).not.toBe(stale.pid);
			const ready = async (child: ReturnType<typeof start>) => {
				const value = Schema.decodeUnknownSync(
					Schema.Struct({ ready: Schema.Literal(true), pid: Schema.Int, connection: Schema.Int }),
				)(await child.next());
				expect(value.pid).toBe(child.pid);
				return value.connection;
			};
			await ready(current);
			const staleId = await ready(stale);
			current.go();
			expect(await current.next()).toEqual({ held: true });
			stale.go();
			await once("waiting", app, JSON.stringify([staleId]));
			current.go();
			expect(await current.next()).toEqual({ result: "current" });
			expect(await stale.next()).toEqual({ result: "stale" });
			await Promise.all([current.finish(), stale.finish()]);
			for (const [leftMode, rightMode] of [
				["reserve", "event"],
				["lock", "lock"],
			] as const) {
				const blocker = start("block", boot);
				expect(await blocker.next()).toEqual({ held: true });
				const left = start(leftMode, boot, "family-left");
				const right = start(rightMode, boot, "family-right");
				expect(left.pid).not.toBe(right.pid);
				const ids = [await ready(left), await ready(right)];
				left.go();
				right.go();
				await once("waiting", boot, JSON.stringify(ids));
				blocker.go();
				if (leftMode === "lock") {
					const outcomes = [await left.next(), await right.next()];
					expect(outcomes).toEqual(expect.arrayContaining([{ acquired: true }, { acquired: false }]));
				}
				await Promise.all([left.finish(), right.finish(), blocker.finish()]);
			}
			await once("inspect", app);
			await once("inspect", boot);
		} finally {
			await Promise.all(
				children.map(
					(child) =>
						new Promise<void>((resolve) => {
							if (child.exitCode !== null || child.signalCode !== null) {
								resolve();
								return;
							}
							child.once("exit", () => resolve());
							child.kill("SIGKILL");
						}),
				),
			);
		}
	},
	30000,
);
