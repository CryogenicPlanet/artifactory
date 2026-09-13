import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const mysqlBin = process.env.COMMS_NATIVE_KEEPER_MYSQL_BIN;

it.skipIf(!mysqlBin).for(["dump", "parent-eof", "late-backend", "prepared-xa", "missing-xa-privilege"] as const)(
	"native MySQL keeper %s preserves the account and XA closure boundary",
	{ timeout: 60000 },
	async (mode, test) => {
		if (!mysqlBin) throw new Error("Missing MySQL fixture tools");
		const root = await realpath(await mkdtemp("/tmp/comms-native-mysql-"));
		await chmod(root, 0o700);
		const datadir = join(root, "mysql");
		const socket = join(root, "mysql.sock");
		const probe = createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const address = probe.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture port");
		const port = address.port;
		await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
		await execute(join(mysqlBin, "mysqld"), ["--no-defaults", "--initialize-insecure", `--datadir=${datadir}`]).catch(
			async (error: unknown) => {
				await rm(root, { recursive: true, force: true });
				throw error;
			},
		);
		const daemon = spawn(
			join(mysqlBin, "mysqld"),
			[
				"--no-defaults",
				`--datadir=${datadir}`,
				`--socket=${socket}`,
				`--port=${port}`,
				"--bind-address=127.0.0.1",
				"--mysqlx=OFF",
				"--skip-log-bin",
				"--performance-schema-session-connect-attrs-size=1024",
				`--pid-file=${join(root, "mysql.pid")}`,
				`--log-error=${join(root, "mysql.log")}`,
			],
			{ stdio: "ignore" },
		);
		const stopped = once(daemon, "exit");
		const query = async (sql: string) =>
			(
				await execute(join(mysqlBin, "mysql"), [
					"--no-defaults",
					"--no-login-paths",
					"--protocol=SOCKET",
					`--socket=${socket}`,
					"--user=root",
					"--batch",
					"--skip-column-names",
					"--execute",
					sql,
				])
			).stdout.trim();
		test.onTestFinished(async () => {
			await query("SHUTDOWN").catch(() => {
				daemon.kill("SIGKILL");
			});
			await stopped;
			await rm(root, { recursive: true, force: true });
		});
		await expect
			.poll(
				async () => {
					try {
						return await query("SELECT 1");
					} catch {
						return "starting";
					}
				},
				{ timeout: 15000 },
			)
			.toBe("1");
		// Exact database grants, not wildcard prefixes. The boot-only XA privilege
		// exists solely in this disposable server; no host global is changed.
		await query(
			"CREATE DATABASE native_source; CREATE DATABASE native_boot; CREATE USER 'native_owner'@'127.0.0.1' IDENTIFIED BY 'fixture-only'; CREATE USER 'native_boot'@'127.0.0.1' IDENTIFIED BY 'fixture-only';",
		);
		await query(
			"GRANT SELECT, SHOW VIEW, TRIGGER ON native_source.* TO 'native_owner'@'127.0.0.1'; GRANT SELECT ON native_boot.* TO 'native_boot'@'127.0.0.1'; GRANT SELECT ON performance_schema.session_account_connect_attrs TO 'native_owner'@'127.0.0.1', 'native_boot'@'127.0.0.1';",
		);
		if (mode !== "missing-xa-privilege") await query("GRANT XA_RECOVER_ADMIN ON *.* TO 'native_boot'@'127.0.0.1';");
		await query(
			"CREATE TABLE native_source.records(id INTEGER PRIMARY KEY, value TEXT, bytes BLOB); INSERT INTO native_source.records VALUES(1,'retained',UNHEX('00ff'));",
		);
		if (mode === "prepared-xa") await query("GRANT INSERT ON native_source.records TO 'native_owner'@'127.0.0.1';");
		const id = "a".repeat(64);
		const data = join(root, "data");
		const wrappers = join(root, "bin");
		await mkdir(data);
		await mkdir(wrappers);
		if (mode !== "dump") {
			const sql =
				mode === "prepared-xa"
					? 'XA START \\"native_keeper_xa\\"; INSERT INTO records VALUES(2,\\"prepared\\",NULL); XA END \\"native_keeper_xa\\"; XA PREPARE \\"native_keeper_xa\\"; SELECT SLEEP(60)'
					: mode === "late-backend"
						? "SELECT SLEEP(2)"
						: "SELECT SLEEP(60)";
			await writeFile(
				join(wrappers, "mysqldump"),
				`#!/bin/sh\necho started > '${join(root, "native.started")}'\nexec '${join(mysqlBin, "mysql")}' "$1" --no-login-paths --ssl-mode=DISABLED --database=native_source --batch --skip-column-names --execute "${sql}"\n`,
				{ mode: 0o700 },
			);
		}
		let admitted = false;
		const admission = createHttpServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.on("end", () => {
				admitted =
					request.url === "/root" &&
					request.headers["x-chirp-guardian-secret"] === "c".repeat(64) &&
					body === JSON.stringify({ action: "admit-owner", attempt: id });
				response.writeHead(admitted ? 204 : 403).end();
			});
		});
		admission.listen(0, "127.0.0.1");
		await once(admission, "listening");
		test.onTestFinished(() => {
			admission.closeAllConnections();
			admission.close();
		});
		const guardian = admission.address();
		if (!guardian || typeof guardian === "string") throw new Error("Missing fixture guardian address");
		const config = {
			id,
			store: `mysql://native_owner:fixture-only@127.0.0.1:${port}/native_source`,
			remote: {
				root: "b".repeat(64),
				dataDirectory: data,
				bootStore: `mysql://native_boot:fixture-only@127.0.0.1:${port}/native_boot`,
				tls: false,
				guardian: { url: `http://127.0.0.1:${guardian.port}`, secret: "c".repeat(64), attempt: "b".repeat(64) },
			},
			operation: "dump",
			path: join(data, "backup"),
			engine: "mysql",
			budgetMs: 10000,
			ownership: "preserve",
		};
		const keeper = spawn("bun", [join(import.meta.dirname, "../src/native-copy-keeper.ts")], {
			env: { PATH: `${wrappers}:${mysqlBin}:${process.env.PATH}`, COMMS_NATIVE_COPY_CONFIG: JSON.stringify(config) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		test.onTestFinished(() => {
			keeper.kill("SIGKILL");
		});
		let output = "";
		keeper.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		keeper.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		const exited = once(keeper, "exit");
		const ownerPath = join(data, "remote-owners", `${id}.json`);
		if (mode === "parent-eof" || mode === "late-backend" || mode === "prepared-xa") {
			await expect
				.poll(
					() =>
						query(
							"SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='native_owner' AND INFO LIKE '%SLEEP(%';",
						),
					{ timeout: 5000 },
				)
				.toBe("1");
			if (mode === "prepared-xa") expect(await query("XA RECOVER")).not.toBe("");
			expect(JSON.parse(await readFile(ownerPath, "utf8")).state).toBe("pending");
			if (mode === "late-backend") {
				// MySQL can cancel SLEEP immediately on client EOF. Keep another
				// session for this exact ephemeral account alive to exercise the
				// account-wide wait independently of local group disappearance.
				const defaults = join(root, "late-client.cnf");
				await writeFile(
					defaults,
					`[client]\nhost=127.0.0.1\nport=${port}\nuser=native_owner\npassword=fixture-only\nprotocol=TCP\n`,
					{ mode: 0o600 },
				);
				const late = spawn(
					join(mysqlBin, "mysql"),
					[
						`--defaults-file=${defaults}`,
						"--no-login-paths",
						"--ssl-mode=DISABLED",
						"--database=native_source",
						"--execute",
						"DO SLEEP(60)",
					],
					{ stdio: "ignore" },
				);
				const lateExited = once(late, "exit");
				test.onTestFinished(() => {
					late.kill("SIGKILL");
				});
				await expect
					.poll(
						() =>
							query(
								"SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='native_owner' AND INFO LIKE '%SLEEP(%';",
							),
						{ timeout: 5000 },
					)
					.toBe("2");
				keeper.stdin.end();
				await expect
					.poll(
						() =>
							query(
								"SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='native_owner' AND INFO LIKE '%SLEEP(%';",
							),
						{ timeout: 5000 },
					)
					.toBe("1");
				expect(JSON.parse(await readFile(ownerPath, "utf8")).state).toBe("pending");
				late.kill("SIGTERM");
				await lateExited;
			} else keeper.stdin.end();
		}
		const [code] = await exited;
		expect(output).toBe("");
		expect(admitted).toBe(true);
		expect(code === 0).toBe(mode === "dump");
		const closed = mode === "dump" || mode === "late-backend" || mode === "parent-eof";
		expect(JSON.parse(await readFile(ownerPath, "utf8")).state).toBe(closed ? "closed" : "pending");
		if (closed)
			expect(await query("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='native_owner';")).toBe("0");
		if (mode === "dump") {
			const dump = await readFile(config.path, "utf8");
			expect(dump).toContain("retained");
			expect(dump).toContain("0x00FF");
		}
		if (mode === "missing-xa-privilege") await expect(readFile(join(root, "native.started"))).rejects.toThrow();
		if (mode === "prepared-xa") {
			expect(await query("XA RECOVER")).not.toBe("");
			// This exact XID belongs to this test; production never resolves unknown XA.
			await query("XA ROLLBACK 'native_keeper_xa'");
		}
	},
);
