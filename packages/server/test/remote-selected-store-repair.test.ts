// Real databases and independent processes. Every scenario requires its own empty role pair.
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { beforeAll, expect, it } from "vitest";
import { remoteRestoreForward } from "./fixtures/remote-restore-forward.ts";
import { remoteMigrationChain } from "./fixtures/remote-migration-chain.ts";
import { repairAuthenticator } from "./fixtures/remote-repair-authenticator.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const Ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const Message = Schema.Struct({ id: Schema.String, body: Schema.String, seq: Schema.Int });
const Evidence = Schema.Struct({
	selected: Schema.String,
	settings: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
	evidence: Schema.Unknown,
	migrationState: Schema.optionalKey(Schema.Unknown),
	forwardState: Schema.optionalKey(Schema.Unknown),
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
	generationErrors: Schema.Array(Schema.Struct({ stderr: Schema.String })),
});
const execute = promisify(execFile);
const scenarios = [
	"missing",
	"foreign",
	"candidate",
	"beforeallocation",
	"afterselection",
	"pending",
	"password",
	"migration",
	"restoreforward",
] as const;

beforeAll(async () => {
	if (process.env.COMMS_REPAIR_CONFIG_DIR && process.env.COMMS_REPAIR_ENGINE)
		await execute("bun", [join(import.meta.dirname, "../stage-runtime.ts")]);
});

for (const scenario of scenarios)
	it.skipIf(!process.env.COMMS_REPAIR_CONFIG_DIR || !process.env.COMMS_REPAIR_ENGINE)(
		`remote selected store repair: ${scenario}`,
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
				// Persist current diagnostics even when ownership cleanup cannot finish within the hook budget.
				for (const save of logs) await save();
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
							child: Schema.Struct({
								state: Schema.String,
								attempt: Schema.Int,
								identity_error: Schema.optionalKey(Schema.Unknown),
							}),
						}),
					)(await (await fetch(`${url}/_boot/status`, { headers: { cookie } })).json());
				const state = async (cookie: string, desired: string, timeout = 15000) => {
					try {
						await expect.poll(async () => (await status(cookie)).child.state, { timeout }).toBe(desired);
					} catch (error) {
						for (const surface of ["status", "generations"])
							await writeFile(
								`${logFile}.${surface}.json`,
								await (await fetch(`${url}/_boot/${surface}`, { headers: { cookie } })).text(),
								{ mode: 0o600 },
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
				const result = await execute("bun", [join(import.meta.dirname, "fixtures/remote-repair-operator.ts")], {
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
			const key = `repair-${scenario}`;
			const input = { topic: "repair", body: "Preserved café 🐘" };
			const created = await first.post("/api/messages", input, cookie, { "idempotency-key": key });
			expect(created.status).toBe(200);
			const message = Schema.decodeUnknownSync(Message)(await created.json());
			const backupReply = await first.post("/_boot/db/backup", {}, cookie);
			if (backupReply.status !== 200)
				await writeFile(join(root, "backup-failure.json"), await backupReply.clone().text(), { mode: 0o600 });
			expect(backupReply.status).toBe(200);
			const backup = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, published_through: Schema.Int }))(
				await backupReply.json(),
			);
			await stop(first.child);
			const before = await operator("inspect");
			if (scenario === "restoreforward") {
				await remoteRestoreForward({
					launch,
					stop,
					operator,
					before,
					cookie,
					input,
					key,
					message,
					root,
					backup: backup.id,
					assertion: device.assertion,
				});
				return;
			}
			if (scenario === "migration") {
				await remoteMigrationChain({ launch, stop, operator, before, cookie, input, key, message, root });
				return;
			}
			if (scenario === "password") {
				const wrong = `wrong/${randomUUID()}@password?fixture`;
				const correct = env.DATABASE_URL;
				env.DATABASE_URL = descriptor({ ...app, password: wrong });
				const privateValues = [wrong, app.password, boot.password, correct, env.DATABASE_URL].flatMap((value) => [
					value,
					encodeURIComponent(value),
					JSON.stringify(value).slice(1, -1),
				]);
				// Boolean assertions never print an actual credential if this regression fails.
				const redacted = (text: string) => {
					expect(privateValues.some((value) => text.includes(value))).toBe(false);
					expect(/\b(?:postgres(?:ql)?|mysql):\/\/(?!\[redacted\]@)[^\s/]*@/i.test(text)).toBe(false);
				};
				const failed = await launch();
				await expect
					.poll(
						async () => {
							const child = (await failed.status(cookie)).child;
							return child.state === "failed" && child.attempt === 3;
						},
						{ timeout: 15000 },
					)
					.toBe(true);
				const write = await failed.post("/api/messages", { topic: "repair", body: "Must not commit" }, cookie);
				expect(write.status).toBe(503);
				const writeBody = await write.text();
				redacted(writeBody);
				expect(writeBody.includes("app_unavailable")).toBe(true);
				for (const surface of ["status", "generations"]) {
					const response = await fetch(`${failed.url}/_boot/${surface}`, { headers: { cookie } });
					expect(response.status).toBe(200);
					redacted(await response.text());
				}
				await stop(failed.child);
				// Inspect stored diagnostics, not only the HTTP projection's second redaction pass.
				const persisted = await operator("inspect");
				expect(persisted.generationErrors.some((row) => row.stderr.length > 0)).toBe(true);
				for (const row of persisted.generationErrors) redacted(row.stderr);
				expect(persisted.generationErrors.some((row) => /remote_|authentication|access denied/i.test(row.stderr))).toBe(
					true,
				);
				expect(persisted.evidence).toEqual(before.evidence);
				expect(persisted.settings).toEqual(before.settings);
				env.DATABASE_URL = correct;
				const recovered = await launch();
				await recovered.state(cookie, "live");
				expect(
					await (await recovered.post("/api/messages", input, cookie, { "idempotency-key": key })).json(),
				).toMatchObject(message);
				expect(
					(await recovered.post("/api/messages", { topic: "repair", body: "Corrected credentials" }, cookie)).status,
				).toBe(200);
				const rows = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Message) }))(
					await (await fetch(`${recovered.url}/api/messages?since=0&topic=repair`, { headers: { cookie } })).json(),
				);
				expect(rows.items.map((row) => row.body)).toEqual([input.body, "Corrected credentials"]);
				await stop(recovered.child);
				return;
			}
			const damaged = await operator(
				scenario === "missing" ? "missing" : scenario === "pending" ? "pending" : "foreign",
			);
			const coordinatorPath = join(bootRoot, "src/database-restore.ts");
			const coordinator = await readFile(coordinatorPath, "utf8");
			const barrier = join(root, "restore-barrier");
			if (["candidate", "beforeallocation", "afterselection"].includes(scenario)) {
				const needle =
					scenario === "candidate"
						? 'yield* candidate.process.health.pipe(Effect.timeout("5 seconds"));'
						: scenario === "beforeallocation"
							? "const restored = yield* backup.restoreInto(target);"
							: "yield* recovery.prepare(epoch);";
				expect(coordinator.split(needle)).toHaveLength(2);
				const replacement =
					scenario === "candidate"
						? 'yield* new ChildError({ code: "health_failed" });'
						: `yield* fs.writeFileString(${JSON.stringify(barrier)}, "held"); yield* Effect.never; ${needle}`;
				await writeFile(coordinatorPath, coordinator.replace(needle, replacement));
			}
			const resumed = await launch();
			await resumed.state(cookie, "failed");
			expect((await fetch(`${resumed.url}/_boot/status`)).status).toBe(401);
			expect((await fetch(`${resumed.url}/api/messages?since=0`, { headers: { cookie } })).status).toBe(503);
			const challenge = Schema.decodeUnknownSync(Ceremony)(
				await (
					await resumed.post("/_boot/auth/challenge", { action: "db.restore", params: { backup: backup.id } }, cookie)
				).json(),
			);
			const proof = Buffer.from(
				JSON.stringify({ id: challenge.id, response: device.assertion(challenge.options.challenge) }),
			).toString("base64url");
			expect((await resumed.post("/_boot/db/restore", { id: backup.id }, cookie)).status).toBe(401);
			const request = () =>
				resumed.post("/_boot/db/restore", { id: backup.id }, cookie, { "X-Chirp-Assertion": proof });
			const verifyRestored = async (running: typeof resumed, result?: unknown) => {
				await running.state(cookie, "live");
				const replay = await running.post("/_boot/db/restore", { id: backup.id }, cookie, {
					"X-Chirp-Assertion": proof,
				});
				expect(replay.status).toBe(200);
				const receipt: unknown = await replay.json();
				expect(receipt).toMatchObject({ status: "restored", safety_backup: null });
				if (result !== undefined) expect(receipt).toEqual(result);
				expect(
					await (await running.post("/api/messages", input, cookie, { "idempotency-key": key })).json(),
				).toMatchObject(message);
				expect((await running.post("/api/messages", { topic: "repair", body: "After repair" }, cookie)).status).toBe(
					200,
				);
				await stop(running.child);
				const repaired = await operator("inspect");
				expect(repaired.selected).not.toBe(damaged.selected);
				expect(repaired.original).toEqual(damaged.original);
				expect(repaired.evidence).toMatchObject({
					identity: [{ store_id: before.settings.find((row) => row.key === "app_store_id")?.value }],
				});
				expect(repaired.settings.find((row) => row.key === "app_store_id")).toEqual(
					before.settings.find((row) => row.key === "app_store_id"),
				);
				const restarted = await launch();
				await restarted.state(cookie, "live");
				const rows = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Message) }))(
					await (await fetch(`${restarted.url}/api/messages?since=0&topic=repair`, { headers: { cookie } })).json(),
				);
				expect(rows.items.map((row) => row.body)).toEqual([input.body, "After repair"]);
				await stop(restarted.child);
			};
			if (scenario === "beforeallocation" || scenario === "afterselection") {
				const response = request().then(
					() => undefined,
					() => undefined,
				);
				await expect.poll(() => readFile(barrier, "utf8").catch(() => ""), { timeout: 20000 }).toBe("held");
				process.kill(Number(await readFile(join(root, "worker.pid"), "utf8")), "SIGKILL");
				await resumed.closed;
				await response;
				await writeFile(coordinatorPath, coordinator);
				const interrupted = await operator("inspect");
				expect(interrupted.restores.find((record) => record.proof_id === challenge.id)).toEqual({
					proof_id: challenge.id,
					phase: scenario === "beforeallocation" ? "restoring" : "working",
				});
				const restarted = await launch();
				if (scenario === "beforeallocation") await verifyRestored(restarted);
				else {
					await restarted.state(cookie, "failed");
					await stop(restarted.child);
					const recovered = await operator("inspect");
					expect(recovered.selected).toBe(damaged.selected);
					expect(recovered.evidence).toEqual(damaged.evidence);
				}
			} else {
				const response = await request();
				const result: unknown = await response.json();
				if (scenario === "missing" || scenario === "foreign") {
					expect(response.status).toBe(200);
					await verifyRestored(resumed, result);
				} else {
					expect(response.status).toBe(409);
					expect(result).toMatchObject({
						status: "failed",
						error: scenario === "candidate" ? "offline_restore_not_accepted" : "restore_preparation_failed",
					});
					await stop(resumed.child);
					await writeFile(coordinatorPath, coordinator);
					const restarted = await launch();
					await restarted.state(cookie, "failed");
					await stop(restarted.child);
					const unchanged = await operator("inspect");
					expect(unchanged.selected).toBe(damaged.selected);
					expect(unchanged.evidence).toEqual(damaged.evidence);
					if (scenario === "pending") expect(unchanged.pending).toEqual(damaged.pending);
				}
			}
		},
		240000,
	);
