import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, type TestContext } from "vitest";
import { authenticator } from "../../../boot/test/fixtures/authenticator.ts";
const execute = promisify(execFile);
const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
export async function conversation(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-conversation-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const device = authenticator();
	let counter = 0;
	const sql = async (statement: string, store = "comms.db") => {
		const { stdout } = await execute("bun", [
			join(import.meta.dirname, "../../../boot/test/fixtures/store.ts"),
			join(root, store),
			statement,
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	const launch = async (
		entry = join(import.meta.dirname, "../../src/server.ts"),
		launcher = join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"),
	) => {
		const processHandle = spawn("bun", [launcher], {
			env: { ...process.env, ENTRY: entry, DATA_DIR: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-32768);
		};
		processHandle.stdout.on("data", capture);
		processHandle.stderr.on("data", capture);
		const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
			if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
			const exited = once(processHandle, "exit");
			processHandle.kill(signal);
			await Promise.race([exited, delay(4000)]);
			if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
			await exited;
		};
		test.onTestFinished(() => stop());
		let url = "";
		await expect
			.poll(
				() => {
					url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
					return url;
				},
				{ timeout: 10000 },
			)
			.not.toBe("");
		// The listener starts before boot finishes opening authentication storage.
		await expect.poll(async () => (await fetch(`${url}/auth/login`)).status, { timeout: 10000 }).toBe(200);
		const post = (path: string, body: unknown, cookie?: string, key?: string) =>
			fetch(`${url}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://comms.test",
					...(cookie ? { cookie } : {}),
					...(key ? { "idempotency-key": key } : {}),
				},
				body: JSON.stringify(body),
			});
		const login = async () => {
			const started = await post("/_boot/auth/login/options", {});
			expect(started.status).toBe(200);
			const options = Schema.decodeUnknownSync(ceremony)(await started.json());
			const response = await post("/_boot/auth/login/verify", {
				id: options.id,
				response: device.assertion(options.options.challenge, ++counter),
			});
			expect(response.status).toBe(200);
			const cookie = response.headers.get("set-cookie")?.split(";")[0];
			if (!cookie) throw Error("Missing cookie");
			return cookie;
		};
		const setup = async () => {
			await expect.poll(() => /\/setup is open, code ([A-F0-9]+)/.exec(output)?.[1]).toBeTruthy();
			const code = /\/setup is open, code ([A-F0-9]+)/.exec(output)?.[1];
			const options = Schema.decodeUnknownSync(ceremony)(
				await (await post("/_boot/auth/setup/options", { code })).json(),
			);
			expect(
				(
					await post("/_boot/auth/setup/verify", {
						id: options.id,
						response: device.registration(options.options.challenge),
					})
				).status,
			).toBe(200);
		};
		const ready = async (cookie: string) => {
			await expect
				.poll(
					async () => {
						const response = await fetch(`${url}/_boot/status`, { headers: { cookie } });
						const value = Schema.decodeUnknownSync(
							Schema.Struct({ child: Schema.Struct({ state: Schema.String, error: Schema.NullOr(Schema.String) }) }),
						)(await response.json());
						return value.child.state === "failed" ? value.child.error : value.child.state;
					},
					{ timeout: 15000 },
				)
				.toBe("live");
		};
		const assertion = async (params: {
			readonly id: string;
			readonly decision: "approve" | "deny";
			readonly scopes: readonly string[];
			readonly long_lived: boolean;
		}) => {
			const started = Schema.decodeUnknownSync(ceremony)(
				await (await post("/_boot/auth/challenge", { action: "enrollment.decide", params })).json(),
			);
			const proof = { id: started.id, response: device.assertion(started.options.challenge, ++counter) };
			return Buffer.from(JSON.stringify(proof)).toString("base64url");
		};
		const revocationAssertion = async (family: string, cookie: string) => {
			const started = Schema.decodeUnknownSync(ceremony)(
				await (await post("/_boot/auth/challenge", { action: "token.revoke", params: { family } }, cookie)).json(),
			);
			return Buffer.from(
				JSON.stringify({ id: started.id, response: device.assertion(started.options.challenge, ++counter) }),
			).toString("base64url");
		};
		return {
			url,
			post,
			login,
			setup,
			ready,
			stop,
			assertion,
			revocationAssertion,
			processHandle,
			output: () => output,
		};
	};
	return { root, launch, sql };
}
