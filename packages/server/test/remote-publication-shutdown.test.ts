// Real databases and independent processes. Every scenario requires its own empty role pair.
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { beforeAll, expect, it } from "vitest";
import { shutdownFailureCodes } from "./fixtures/shutdown-failure-codes.ts";
import { repairAuthenticator } from "./fixtures/remote-repair-authenticator.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const HeldBatch = Schema.Struct({
	transaction: Schema.String,
	attempt: Schema.String,
	from: Schema.Int,
	to: Schema.Int,
	count: Schema.Int,
});
const Ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });

const Evidence = Schema.Struct({
	sequence: Schema.Array(Schema.Struct({ next: Schema.Int, published_through: Schema.Int })),
	children: Schema.Array(Schema.Struct({ closed: Schema.Int })),
	selected: Schema.String,
	settings: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
	evidence: Schema.Unknown,
	original: Schema.Unknown,
	pending: Schema.Array(
		Schema.Struct({
			pending_id: Schema.NullOr(Schema.String),
			pending_attempt: Schema.NullOr(Schema.String),
			pending_from: Schema.NullOr(Schema.Int),
			pending_to: Schema.NullOr(Schema.Int),
		}),
	),
	restores: Schema.Array(Schema.Struct({ proof_id: Schema.String, phase: Schema.String })),
});
const execute = promisify(execFile);
const scenarios = ["shutdownnormal", "shutdownforce"] as const;

beforeAll(async () => {
	if (process.env.COMMS_REPAIR_CONFIG_DIR && process.env.COMMS_REPAIR_ENGINE)
		await execute("bun", [join(import.meta.dirname, "../stage-runtime.ts")]);
});

for (const scenario of scenarios)
	it.skipIf(!process.env.COMMS_REPAIR_CONFIG_DIR || !process.env.COMMS_REPAIR_ENGINE)(
		`remote held publication shutdown: ${scenario}`,
		async (test) => {
			const engine = process.env.COMMS_REPAIR_ENGINE;
			const directory = process.env.COMMS_REPAIR_CONFIG_DIR;
			if (!directory || (engine !== "pg" && engine !== "mysql"))
				throw new Error("Missing private repair configuration");
			const settings = async (which: string) =>
				Schema.decodeSync(Schema.fromJsonString(Settings))(
					await readFile(join(directory, `${engine}-repair-${scenario}-${which}.json`), "utf8"),
				);
			const boot = await settings("boot"),
				app = await settings("app");
			const descriptor = (value: typeof Settings.Type) =>
				`${value.engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${value.host}:${value.port}/${encodeURIComponent(value.database)}`;
			const root = await realpath(await mkdtemp(join(tmpdir(), "comms-remote-repair-")));
			await writeFile(
				join(root, "fixture.json"),
				JSON.stringify({ engine, scenario, root, configDirectory: directory, boot: boot.database, app: app.database }),
				{ flag: "wx", mode: 0o600 },
			);
			const bootRoot = join(root, "packages/boot");
			const fixtureRoot = join(root, "packages/server/test/fixtures");
			await mkdir(fixtureRoot, { recursive: true });
			await cp(join(import.meta.dirname, "../../boot/src"), join(bootRoot, "src"), { recursive: true });
			await symlink(join(import.meta.dirname, "../../boot/node_modules"), join(bootRoot, "node_modules"));
			await symlink(join(import.meta.dirname, "../node_modules"), join(root, "packages/server/node_modules"));
			await cp(
				join(import.meta.dirname, "fixtures/remote-repair-launcher.ts"),
				join(fixtureRoot, "remote-repair-launcher.ts"),
			);
			const appendHeld = join(root, "append-held"),
				appendRelease = join(root, "append-release"),
				draining = join(root, "draining");
			const eventsPath = join(bootRoot, "src/events.ts");
			const events = await readFile(eventsPath, "utf8");
			const appendAnchor = "const current = yield* writeState;\n\t\t\t\tconst records =";
			expect(events.split(appendAnchor)).toHaveLength(2);
			await writeFile(
				eventsPath,
				events
					.replace("Clock, Context,", "FileSystem, Clock, Context,")
					.replace(
						appendAnchor,
						`if (batch.events.some(event => event.topic === "shutdown-probe")) { const fs = yield* FileSystem.FileSystem; yield* fs.writeFileString(${JSON.stringify(appendHeld)}, JSON.stringify({transaction:batch.transaction,attempt,from:batch.from,to:batch.to,count:batch.events.length}), {mode:0o600}); while (!(yield* fs.exists(${JSON.stringify(appendRelease)}))) yield* Effect.sleep("10 millis"); } ${appendAnchor}`,
					),
			);
			const supervisorPath = join(bootRoot, "src/supervisor.ts");
			const supervisor = await readFile(supervisorPath, "utf8");
			const drainAnchor = 'const mutations = yield* routing.drained.pipe(Effect.timeout("5 seconds"), Effect.exit);';
			expect(supervisor.split(drainAnchor)).toHaveLength(2);
			await writeFile(
				supervisorPath,
				supervisor.replace(
					drainAnchor,
					`yield* fs.writeFileString(${JSON.stringify(draining)}, "draining"); ${drainAnchor}`,
				),
			);
			await cp(
				join(import.meta.dirname, "fixtures/remote-repair-operator.ts"),
				join(fixtureRoot, "remote-repair-operator.ts"),
			);

			const env = {
				...process.env,
				DATABASE_URL: descriptor(app),
				BOOT_DATABASE_URL: descriptor(boot),
				DATABASE_TLS: "false",
				DATA_DIR: root,
				ENTRY: join(import.meta.dirname, "../dist/runtime-seed/server.ts"),
				DEPENDENCIES_DIRECTORY: join(import.meta.dirname, "../node_modules"),
			};
			const device = repairAuthenticator();
			const children: Array<ReturnType<typeof spawn>> = [];
			const logs: Array<() => Promise<void>> = [];
			const stop = async (child: ReturnType<typeof spawn>) => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				const closed = once(child, "close");
				child.kill("SIGTERM");
				await closed;
			};
			test.onTestFinished(async () => {
				for (const child of children) await stop(child);
				for (const save of logs) await save();
				// Even a passing expected-failure case can own unfinished native resources.
				// Preserve this private root and fixture.json for environment-owner cleanup.
				console.info(`Remote repair fixture retained: ${root}`);
			});
			const launch = async () => {
				const child = spawn("bun", [join(fixtureRoot, "remote-repair-launcher.ts")], {
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});
				children.push(child);
				const closed = once(child, "close");
				let output = "";
				const logFile = join(root, `launcher-${children.length}.log`);
				logs.push(() => writeFile(logFile, output, { mode: 0o600 }));
				child.stdout?.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				let url = "";
				// The guardian also announces a private HTTP listener; only the public
				// boot listener exposes authentication. Refresh while boot starts.
				await expect
					.poll(
						async () => {
							url = Array.from(output.matchAll(/Listening on (http:\/\/127\.0\.0\.1:\d+)/g)).at(-1)?.[1] ?? "";
							return url ? (await fetch(`${url}/auth/login`)).status : 0;
						},
						{ timeout: 15000 },
					)
					.toBe(200);
				const post = (path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}) =>
					fetch(`${url}${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "https://comms.test",
							...(cookie ? { cookie } : {}),
							...extra,
						},
						body: JSON.stringify(body),
					});
				const status = async (cookie: string) =>
					Schema.decodeUnknownSync(
						Schema.Struct({
							child: Schema.Struct({ state: Schema.String, identity_error: Schema.optionalKey(Schema.Unknown) }),
						}),
					)(await (await fetch(`${url}/_boot/status`, { headers: { cookie } })).json());
				const state = async (cookie: string, desired: string, timeout = 15000) => {
					try {
						await expect.poll(async () => (await status(cookie)).child.state, { timeout }).toBe(desired);
					} catch (error) {
						for (const surface of ["status", "generations"]) {
							const detail = await (await fetch(`${url}/_boot/${surface}`, { headers: { cookie } })).text();
							await writeFile(`${logFile}.${surface}.json`, detail, { mode: 0o600 });
							console.error(
								JSON.stringify({
									event: "native_shutdown_startup_failure",
									surface,
									codes: shutdownFailureCodes(detail),
								}),
							);
						}
						console.error(
							JSON.stringify({
								event: "native_shutdown_startup_failure",
								surface: "launcher",
								codes: shutdownFailureCodes(output),
							}),
						);
						throw error;
					}
				};
				const login = async () => {
					const options = Schema.decodeUnknownSync(Ceremony)(
						await (await post("/_boot/auth/login/options", {})).json(),
					);
					const response = await post("/_boot/auth/login/verify", {
						id: options.id,
						response: device.assertion(options.options.challenge),
					});
					expect(response.status).toBe(200);
					const cookie = response.headers.get("set-cookie")?.split(";")[0];
					if (!cookie) throw new Error("Missing private fixture session");
					return cookie;
				};
				return { child, closed, url, post, status, state, login, output: () => output };
			};
			const operator = async (action: string) => {
				const result = await execute("bun", [join(fixtureRoot, "remote-repair-operator.ts")], {
					env: { ...env, REPAIR_ACTION: action },
					timeout: 30000,
				});
				const evidence = result.stdout.split("\n").filter((line) => line.startsWith('{"selected":'));
				expect(evidence).toHaveLength(1);
				return Schema.decodeSync(Schema.fromJsonString(Evidence))(evidence[0] ?? "");
			};
			const first = await launch();
			await expect.poll(() => /\/setup is open, code ([A-F0-9]+)/.exec(first.output())?.[1]).toBeTruthy();
			const setup = Schema.decodeUnknownSync(Ceremony)(
				await (
					await first.post("/_boot/auth/setup/options", {
						code: /\/setup is open, code ([A-F0-9]+)/.exec(first.output())?.[1],
					})
				).json(),
			);
			expect(
				(
					await first.post("/_boot/auth/setup/verify", {
						id: setup.id,
						response: device.registration(setup.options.challenge),
					})
				).status,
			).toBe(200);
			const cookie = await first.login();
			// Match the existing runtime-preparation acceptance budget for install/copy/build.
			await first.state(cookie, "live", 90000);
			const writing = first
				.post("/api/messages", { topic: "shutdown-probe", body: "Acknowledged after drain" }, cookie)
				.then((response) => response.status)
				.catch(() => 0);
			await expect
				.poll(async () => {
					try {
						Schema.decodeSync(Schema.fromJsonString(HeldBatch))(await readFile(appendHeld, "utf8"));
						return "held";
					} catch {
						return "";
					}
				})
				.toBe("held");
			const held = Schema.decodeSync(Schema.fromJsonString(HeldBatch))(await readFile(appendHeld, "utf8"));
			if (scenario === "shutdownnormal") {
				first.child.kill("SIGTERM");
				await expect
					.poll(async () => {
						try {
							return await readFile(draining, "utf8");
						} catch {
							return "";
						}
					})
					.toBe("draining");
				await writeFile(appendRelease, "release");
				expect(await writing).toBe(200);
			} else {
				const worker = Number(await readFile(join(root, "worker.pid"), "utf8"));
				process.kill(worker, "SIGKILL");
				await writing;
			}
			await first.closed;
			const after = await operator("inspect");
			const summary = {
				pending: after.pending.map((row) => ({
					id: row.pending_id !== null,
					attempt: row.pending_attempt !== null,
					from: row.pending_from !== null,
					to: row.pending_to !== null,
				})),
				sequence: after.sequence,
				children: after.children,
			};
			await writeFile(join(root, "shutdown-evidence.json"), JSON.stringify(summary), { mode: 0o600 });
			if (scenario === "shutdownnormal") {
				expect(summary.pending).toEqual([{ id: false, attempt: false, from: false, to: false }]);
				expect(after.sequence[0]?.next).toBe((after.sequence[0]?.published_through ?? 0) + 1);
				expect(after.children.length).toBeGreaterThan(0);
				expect(after.children.every((row) => row.closed === 1)).toBe(true);
			} else {
				expect(summary.pending).toEqual([{ id: true, attempt: true, from: true, to: true }]);
				const pending = after.pending[0];
				expect(pending?.pending_from).toBe((after.sequence[0]?.published_through ?? 0) + 1);
				expect(pending?.pending_id === held.transaction).toBe(true);
				expect(pending?.pending_attempt === held.attempt).toBe(true);
				expect(pending?.pending_from).toBe(held.from);
				expect(pending?.pending_to).toBe(held.to);
				expect(held.to - held.from + 1).toBe(held.count);
				// The new topic emits topic.created and message.created.
				expect(held.count).toBe(2);
				// Later boot diagnostics may advance next without publishing this held batch.
				expect(after.sequence[0]?.next).toBeGreaterThanOrEqual(held.to + 2);
			}
		},
		150000,
	);
