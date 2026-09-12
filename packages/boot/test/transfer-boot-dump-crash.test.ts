// Requires an exclusive disposable boot/app pair and native tools; run with one worker.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const Ready = Schema.Struct({
	worker: Schema.Int,
	root: Schema.String,
	id: Schema.String,
	principal: Schema.String,
	store: Schema.String,
});
const Receipt = Schema.Struct({
	state: Schema.String,
	inspector: Schema.NullOr(Schema.Struct({ connectionId: Schema.String, server: Schema.String })),
});
const shell = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const execute = promisify(execFile);

it.skipIf(
	!process.env.COMMS_REMOTE_TEST_CONFIG ||
		!process.env.COMMS_REMOTE_BOOT_TEST_CONFIG ||
		!process.env.COMMS_BOOT_DUMP_BIN,
)(
	"boot dump survives worker SIGKILL and retains its original inspector until the complete account closes",
	{ timeout: 60000 },
	async (test) => {
		const configFile = process.env.COMMS_REMOTE_BOOT_TEST_CONFIG;
		const bin = process.env.COMMS_BOOT_DUMP_BIN;
		if (!configFile || !bin) throw new Error("Missing private boot dump configuration");
		const config = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(configFile, "utf8"));
		const root = await realpath(await mkdtemp(join(tmpdir(), "comms-boot-dump-crash-")));
		const wrappers = join(root, "bin");
		await mkdir(wrappers);
		const nativePidFile = join(root, "native.pid");
		const pg = config.engine === "pg";
		await writeFile(
			join(wrappers, pg ? "pg_dump" : "mysqldump"),
			`#!/bin/sh\necho $$ > ${shell(nativePidFile)}\nexec ${shell(join(bin, pg ? "psql" : "mysql"))} ${pg ? "-X -Atc 'SELECT pg_sleep(60)'" : `"$1" --no-login-paths --ssl-mode=DISABLED --database=${shell(config.database)} --batch --skip-column-names --execute 'SELECT SLEEP(60)'`}\n`,
			{ mode: 0o700 },
		);
		const command = async (settings: typeof Settings.Type, name: string) => {
			if (pg)
				return {
					command: join(bin, "psql"),
					args: ["-X", "-At", "-v", "ON_ERROR_STOP=1"],
					env: {
						PATH: process.env.PATH,
						PGHOST: settings.host,
						PGPORT: String(settings.port),
						PGUSER: settings.username,
						PGPASSWORD: settings.password,
						PGDATABASE: settings.database,
						PGSSLMODE: "disable",
						PGPASSFILE: "/dev/null",
					},
				};
			const defaults = join(root, `${name}.cnf`);
			const quote = (text: string) => JSON.stringify(text);
			await writeFile(
				defaults,
				`[client]\nhost=${quote(settings.host)}\nport=${settings.port}\nuser=${quote(settings.username)}\npassword=${quote(settings.password)}\nprotocol=TCP\n`,
				{ mode: 0o600 },
			);
			return {
				command: join(bin, "mysql"),
				args: [
					`--defaults-file=${defaults}`,
					"--no-login-paths",
					"--ssl-mode=DISABLED",
					`--database=${settings.database}`,
					"--batch",
					"--skip-column-names",
					"--unbuffered",
				],
				env: { PATH: process.env.PATH },
			};
		};
		const bootCommand = await command(config, "boot");
		const query = async (sql: string) =>
			(
				await execute(bootCommand.command, [...bootCommand.args, pg ? "-c" : "--execute", sql], {
					env: bootCommand.env,
				})
			).stdout.trim();
		const entry = join(import.meta.dirname, "fixtures/transfer-boot-dump-crash.ts");
		const launcher = spawn("bun", [entry, root], {
			env: { ...process.env, PATH: `${wrappers}:${bin}:${process.env.PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const launcherClosed = once(launcher, "close");
		let output = "";
		launcher.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		launcher.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		let ready: typeof Ready.Type | undefined;
		let nativePid: number | undefined;
		let verified = false;
		let closeLate: (() => Promise<void>) | undefined;
		test.onTestFinished(async () => {
			await closeLate?.();
			if (!verified && pg && ready)
				await query(
					`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='${ready.principal}' AND query='SELECT pg_sleep(60)'`,
				).catch(() => undefined);
			if (!verified)
				for (const pid of [nativePid ? -nativePid : undefined, ready ? -ready.worker : undefined]) {
					if (pid === undefined) continue;
					try {
						process.kill(pid, "SIGKILL");
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
					}
				}
			if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
			await launcherClosed;
			// Retain an unsuccessful private journal for exact principal cleanup and diagnosis.
			if (verified) await rm(root, { recursive: true, force: true });
		});
		await expect
			.poll(() => readFile(join(root, "ready.json"), "utf8").catch(() => ""), { timeout: 10000 })
			.not.toBe("");
		ready = Schema.decodeSync(Schema.fromJsonString(Ready))(await readFile(join(root, "ready.json"), "utf8"));
		const selected = ready;
		expect(selected.principal).toMatch(/^comms_t_[a-f0-9]{24}$/);
		const url = new URL(selected.store);
		const lateCommand = await command(
			{ ...config, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
			"late",
		);
		const accountQuery = async (sql: string) =>
			(
				await execute(lateCommand.command, [...lateCommand.args, pg ? "-c" : "--execute", sql], {
					env: lateCommand.env,
				})
			).stdout.trim();
		const active = () =>
			(pg ? query : accountQuery)(
				pg
					? `SELECT count(*) FROM pg_stat_activity WHERE usename='${selected.principal}' AND query='SELECT pg_sleep(60)'`
					: `SELECT count(*) FROM information_schema.PROCESSLIST WHERE USER='${selected.principal}' AND INFO='SELECT SLEEP(60)'`,
			);
		await expect.poll(active, { timeout: 10000 }).toBe("1");
		nativePid = Number(await readFile(nativePidFile, "utf8"));
		expect(nativePid).toBeGreaterThan(1);
		const receiptPath = join(root, "remote-owners", `${selected.id}.json`);
		const receipt = async () => Schema.decodeSync(Schema.fromJsonString(Receipt))(await readFile(receiptPath, "utf8"));
		const original = await receipt();
		expect(original.state).toBe("pending");
		expect(original.inspector).not.toBeNull();
		const late = spawn(lateCommand.command, lateCommand.args, {
			env: lateCommand.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lateClosed = once(late, "close");
		closeLate = async () => {
			if (late.exitCode === null && late.signalCode === null) late.kill("SIGKILL");
			await lateClosed;
		};
		let lateReady = false;
		late.stdout.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("1")) lateReady = true;
		});
		late.stdin.write("SELECT 1;\n");
		await expect.poll(() => lateReady, { timeout: 5000 }).toBe(true);
		process.kill(selected.worker, "SIGKILL");
		await expect
			.poll(
				() => {
					try {
						if (nativePid) process.kill(-nativePid, 0);
						return false;
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
						throw error;
					}
				},
				{ timeout: 5000 },
			)
			.toBe(true);
		// Remove PostgreSQL's disconnected sleeping query before testing the independent late-session barrier.
		if (pg)
			await query(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='${selected.principal}' AND query='SELECT pg_sleep(60)'`,
			);
		await expect.poll(active, { timeout: 5000 }).toBe("0");
		// Retain the unrelated connection across several real inspector retry intervals.
		for (let observation = 0; observation < 3; observation++) {
			await delay(200);
			expect(await receipt()).toEqual(original);
			expect(launcher.exitCode).toBeNull();
			const rootReceipt = Schema.decodeSync(Schema.fromJsonString(Receipt))(
				await readFile(join(root, "remote-owners", `${selected.root}.json`), "utf8"),
			);
			expect(rootReceipt.state).toBe("pending");
		}
		late.kill("SIGTERM");
		await lateClosed;
		expect((await launcherClosed)[0]).toBe(0);
		expect(output).toContain("BOOT_DUMP_crash_VERIFIED");
		const completed = await receipt();
		expect(completed).toEqual({ ...original, state: "closed" });
		const previous = await readFile(receiptPath, "utf8");
		const reopened = await execute("bun", [entry, root, "reopen"], { env: process.env, timeout: 20000 });
		expect(reopened.stdout).toContain("BOOT_DUMP_reopen_VERIFIED");
		expect(await readFile(receiptPath, "utf8")).toBe(previous);
		expect(output).not.toContain(config.password);
		expect(output).not.toContain(decodeURIComponent(url.password));
		verified = true;
	},
);
