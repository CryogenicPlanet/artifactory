// Disposable native acceptance. Provision fresh role/database pairs separately; never seed board rows.
/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/process-env, effecttsgo/prefer-schema-over-json */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";

const Connection = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
async function run() {
	const [appFile, bootFile, existingRoot, existingOrigin] = process.argv.slice(2);
	assert(appFile && bootFile, "Supply protected fresh app and boot configuration paths");
	const load = async (filename: string) => {
		try {
			return Schema.decodeSync(Schema.fromJsonString(Connection))(await readFile(filename, "utf8"));
		} catch {
			throw new Error("Invalid protected database configuration");
		}
	};
	const app = await load(appFile);
	const boot = await load(bootFile);
	assert.equal(app.engine, boot.engine);
	assert.notEqual(app.database, boot.database);
	assert.notEqual(app.username, boot.username);
	const descriptor = (value: typeof Connection.Type) =>
		`${value.engine === "pg" ? "postgres" : "mysql"}://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${value.host}:${value.port}/${encodeURIComponent(value.database)}`;
	const root = await realpath(existingRoot ?? (await mkdtemp(join(tmpdir(), `comms-native-board-${app.engine}-`))));
	const listener = createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const address = listener.address();
	assert(address && typeof address !== "string");
	await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
	const savedOrigin = existingRoot ? (await readFile(join(root, "origin"), "utf8")).trim() : undefined;
	if (savedOrigin && existingOrigin)
		assert.equal(existingOrigin, savedOrigin, "Resume origin conflicts with retained board");
	const origin = savedOrigin ?? existingOrigin ?? `http://localhost:${address.port}`;
	const parsedOrigin = new URL(origin);
	assert(
		parsedOrigin.protocol === "http:" && parsedOrigin.hostname === "localhost" && parsedOrigin.port,
		"Expected loopback test origin",
	);
	const port = Number(parsedOrigin.port);
	if (!existingRoot) await writeFile(join(root, "origin"), origin, { mode: 0o600, flag: "wx" });
	const setupFile = join(root, "setup-code");
	const stateFile = join(root, "state.json");
	let output = "";
	const redact = (text: string) =>
		text
			.split(app.password)
			.join("[APP SECRET]")
			.split(boot.password)
			.join("[BOOT SECRET]")
			.replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, "[DATABASE URL]")
			.replace(/code\s+\S+/gi, "code [REDACTED]")
			.replace(/\b[a-f0-9]{32,}\b/gi, "[SECRET]");
	const launch = () => {
		const child = spawn("bun", [join(import.meta.dirname, "../packages/server/src/main.ts")], {
			env: {
				...process.env,
				DATA_DIR: join(root, "data"),
				DATABASE_URL: descriptor(app),
				BOOT_DATABASE_URL: descriptor(boot),
				DATABASE_TLS: "false",
				HOST: "127.0.0.1",
				PORT: String(port),
				RP_ID: "localhost",
				PUBLIC_ORIGIN: origin,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-100000);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-100000);
		});
		const closed = once(child, "close");
		return { child, closed };
	};
	let running = launch();
	let closureVerified = false;
	const stop = async () => {
		if (closureVerified) return;
		const requested = running.child.exitCode === null && running.child.signalCode === null;
		if (requested) running.child.kill("SIGTERM");
		const deadline = new AbortController();
		try {
			await Promise.race([
				running.closed,
				setTimeout(45000, undefined, { signal: deadline.signal }).then(() => {
					throw new Error("Server closure unproven; retained private journals");
				}),
			]);
			if (!requested) assert.equal(running.child.exitCode, 0, "Server exited before requested shutdown");
			await promisify(execFile)(
				"bun",
				[
					join(import.meta.dirname, "../packages/boot/test/fixtures/remote-owner-inventory.ts"),
					join(root, "data"),
					"recover",
				],
				{ timeout: 10000 },
			);
			closureVerified = true;
		} finally {
			deadline.abort();
		}
	};
	const ready = async (setup: boolean) => {
		for (let n = 0; n < 480; n++) {
			if (running.child.exitCode !== null || running.child.signalCode !== null)
				throw new Error("Actual server entry exited during startup");
			const code = output.match(/comms: \/setup is open, code ([A-Za-z0-9-]+)/)?.[1];
			if (!setup || code) {
				try {
					const response = await fetch(`${origin}${setup ? "/setup" : "/auth/login"}`, {
						signal: AbortSignal.timeout(1000),
					});
					await response.arrayBuffer();
					if (response.ok) {
						if (code && setup) await writeFile(setupFile, code, { mode: 0o600 });
						return;
					}
				} catch {
					/* startup still binding */
				}
			}
			await setTimeout(250);
		}
		throw new Error("Actual server startup did not publish authentication page within 120 seconds");
	};
	const probe = (phase: string) =>
		promisify(execFile)("bun", [join(import.meta.dirname, "remote-board-http.ts"), phase, origin, stateFile], {
			env: {
				...process.env,
				COMMS_TEST_ORIGIN: origin,
				COMMS_SETUP_CODE_FILE: setupFile,
				COMMS_TEST_DIAGNOSTICS_FILE: join(root, "private-generations.json"),
			},
			timeout: 360000,
		});
	let phase = "first startup";
	let succeeded = false;
	try {
		if (existingRoot) {
			await ready(false);
			phase = "resumed authenticated diagnostic";
			console.log((await probe("diagnose")).stdout.trim());
			await stop();
			console.log("Resumed board diagnosis completed; private board preserved");
			return;
		}
		await ready(true);
		console.log("Actual server started; passkey HTTP probe begins");
		phase = "public passkey, messages, idempotency, native backup and restore";
		console.log((await probe("prepare")).stdout.trim());
		phase = "graceful server shutdown";
		await stop();

		output = "";
		running = launch();
		closureVerified = false;
		phase = "actual server restart";
		await ready(false);
		phase = "post-restart authenticated persistence and fresh writes";
		console.log((await probe("check-restarted")).stdout.trim());
		phase = "final graceful shutdown";
		await stop();
		succeeded = true;
		console.log(`Native ${app.engine} actual board acceptance passed`);
	} catch (error) {
		console.error(`Native board failed during ${phase}`);
		const detail = error instanceof Error ? error.message : "Unknown failure";
		const safe = detail.match(
			/(?:HTTP [0-9]{3}|Actual server [A-Za-z /0-9]+|Board readiness deadline: [a-zA-Z0-9 ]+|Board generation failed: generation [0-9]+|Board boot recovery failed)/,
		)?.[0];
		console.error(safe ?? "Probe or process failed; response details withheld");
		await writeFile(join(root, "private-board.log"), output, { mode: 0o600 });
		console.error(redact(output));
		throw new Error("Native board acceptance failed");
	} finally {
		if (succeeded) await rm(root, { recursive: true, force: true });
		else {
			try {
				await stop();
			} catch {
				console.error("Server closure unproven; private recovery evidence retained");
			}
			console.error(`Private native acceptance evidence retained at ${root}`);
		}
	}
}
await run();
