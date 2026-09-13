import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const pgBin = process.env.COMMS_NATIVE_KEEPER_PG_BIN;
const entry = join(import.meta.dirname, "../src/native-copy-keeper.ts");

it("never prints invalid private keeper configuration", async () => {
	const child = spawn("bun", [entry], {
		env: { PATH: process.env.PATH, COMMS_NATIVE_COPY_CONFIG: '{"secret":"DO_NOT_PRINT_NATIVE_SECRET"}' },
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const [code] = await once(child, "exit");
	expect(code).not.toBe(0);
	expect(output).toBe("");
});

it("refused root admission opens no owner journal", async (test) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "comms-native-admission-")));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	let requested = false;
	const server = createHttpServer((_request, response) => {
		requested = true;
		response.writeHead(403).end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	test.onTestFinished(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture admission address");
	const configuration = {
		id: "a".repeat(64),
		store: "postgres://native:DO_NOT_PRINT_NATIVE_SECRET@127.0.0.1:1/native",
		remote: {
			root: "b".repeat(64),
			dataDirectory: root,
			bootStore: "postgres://boot:DO_NOT_PRINT_NATIVE_SECRET@127.0.0.1:1/boot",
			tls: false,
			guardian: { url: `http://127.0.0.1:${address.port}`, secret: "c".repeat(64), attempt: "b".repeat(64) },
		},
		operation: "dump",
		path: join(root, "backup"),
		engine: "pg",
		budgetMs: 1000,
		ownership: "preserve",
	};
	const child = spawn("bun", [entry], {
		env: { PATH: process.env.PATH, COMMS_NATIVE_COPY_CONFIG: JSON.stringify(configuration) },
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const [code] = await once(child, "exit");
	expect(code).not.toBe(0);
	expect(output).toBe("");
	expect(requested).toBe(true);
	await expect(readFile(join(root, "remote-owners", `${configuration.id}.intent`))).rejects.toThrow();
});

it.skipIf(!pgBin).for(["success", "descendant", "parent-eof", "late-backend"] as const)(
	"native PostgreSQL keeper %s requires group and account closure",
	{ timeout: 45000 },
	async (mode, test) => {
		if (!pgBin) throw new Error("Missing PostgreSQL fixture tools");
		const directory = await realpath(await mkdtemp(join(tmpdir(), "comms-native-keeper-")));
		const database = join(directory, "postgres");
		await chmod(directory, 0o700);
		const probe = createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const address = probe.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture port");
		const port = address.port;
		await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
		await execute(join(pgBin, "initdb"), ["-D", database, "--auth=trust", "--no-locale", "-U", "postgres"]);
		await execute(join(pgBin, "pg_ctl"), [
			"-D",
			database,
			"-l",
			join(directory, "server.log"),
			"-o",
			`-h 127.0.0.1 -p ${port} -k ${directory}`,
			"-w",
			"start",
		]);
		test.onTestFinished(async () => {
			await execute(join(pgBin, "pg_ctl"), ["-D", database, "-m", "immediate", "-w", "stop"]);
			await rm(directory, { recursive: true, force: true });
		});
		const env = {
			PATH: process.env.PATH,
			PGHOST: "127.0.0.1",
			PGPORT: String(port),
			PGUSER: "postgres",
			PGDATABASE: "postgres",
		};
		const query = async (sql: string) =>
			(await execute(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql], { env })).stdout.trim();
		await query("CREATE ROLE native_owner LOGIN PASSWORD 'fixture-only';");
		await query("CREATE DATABASE native_source OWNER native_owner;");
		await query("CREATE DATABASE native_boot;");
		const id = "a".repeat(64);
		const artifacts = join(directory, "data");
		await mkdir(artifacts);
		const wrappers = join(directory, "bin");
		await mkdir(wrappers);
		if (mode === "descendant") {
			await writeFile(
				join(wrappers, "pg_dump"),
				`#!/bin/sh\nsleep 60 >/dev/null 2>&1 &\necho $! > '${join(directory, "descendant.pid")}'\nexit 0\n`,
				{ mode: 0o700 },
			);
		} else if (mode !== "success") {
			// The native process is immutable in production. This fixture creates the
			// exact same process-group shape while holding a real server query open.
			const sql = mode === "late-backend" ? "SELECT pg_sleep(2)" : "SELECT pg_sleep(60)";
			await writeFile(join(wrappers, "pg_dump"), `#!/bin/sh\nexec '${join(pgBin, "psql")}' -X -Atc '${sql}'\n`, {
				mode: 0o700,
			});
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
		const admissionAddress = admission.address();
		if (!admissionAddress || typeof admissionAddress === "string") throw new Error("Missing fixture guardian address");
		const configuration = {
			id,
			store: `postgres://native_owner:fixture-only@127.0.0.1:${port}/native_source`,
			remote: {
				root: "b".repeat(64),
				dataDirectory: artifacts,
				bootStore: `postgres://postgres:fixture-only@127.0.0.1:${port}/native_boot`,
				tls: false,
				guardian: { url: `http://127.0.0.1:${admissionAddress.port}`, secret: "c".repeat(64), attempt: "b".repeat(64) },
			},
			operation: "dump",
			path: join(artifacts, "backup"),
			engine: "pg",
			budgetMs: 10000,
			ownership: "preserve",
		};
		const child = spawn("bun", [entry], {
			env: {
				PATH: `${wrappers}:${pgBin}:${process.env.PATH}`,
				COMMS_NATIVE_COPY_CONFIG: JSON.stringify(configuration),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		test.onTestFinished(() => {
			child.kill("SIGKILL");
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		const exited = once(child, "exit");
		const ownerPath = join(artifacts, "remote-owners", `${id}.json`);
		if (mode === "parent-eof" || mode === "late-backend") {
			await expect
				.poll(
					() =>
						query(
							"SELECT COUNT(*) FROM pg_stat_activity WHERE usename='native_owner' AND query LIKE 'SELECT pg_sleep%';",
						),
					{ timeout: 5000 },
				)
				.toBe("1");
			expect(JSON.parse(await readFile(ownerPath, "utf8")).state).toBe("pending");
			child.stdin.end();
		}
		const [code] = await exited;
		expect(output).toBe("");
		expect(admitted).toBe(true);
		if (mode === "success" || mode === "descendant") {
			expect(code).toBe(0);
		} else {
			expect(code).not.toBe(0);
		}
		if (mode === "descendant") {
			const pid = Number(await readFile(join(directory, "descendant.pid"), "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
		}
		if (mode === "parent-eof") expect(JSON.parse(await readFile(ownerPath, "utf8")).state).toBe("pending");
		else expect(JSON.parse(await readFile(ownerPath, "utf8")).state).toBe("closed");
	},
);
