import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("drains an aborted extension GET only after its returned Promise completes its late SQL write", async (test) => {
	const fixture = await conversation(test);
	const boot = await fixture.launch();
	await boot.setup();
	const cookie = await boot.login();
	await boot.ready(cookie);
	await boot.stop();
	await fixture.sql("UPDATE kernel_writer SET epoch='drain-test'");
	await fixture.sql("CREATE TABLE late_request(value TEXT)");
	const source = join(fixture.root, "request-app");
	await cp(join(import.meta.dirname, "../src"), source, { recursive: true });
	await symlink(join(import.meta.dirname, "../../../node_modules"), join(fixture.root, "node_modules"));
	await symlink(join(import.meta.dirname, "../node_modules"), join(source, "node_modules"));
	await mkdir(join(source, "ext"), { recursive: true });
	await writeFile(
		join(source, "ext/request-drain.ts"),
		`
import { Effect } from "effect";
export default function(api) {
 api.route("GET", "/api/late-write", { description: "Held request", scope: "read", handler: async (_request, ctx) => {
  const root = process.env.TEST_REQUEST_DIRECTORY;
  await Bun.write(root + "/started", "started");
  while (!(await Bun.file(root + "/release").exists())) await Bun.sleep(10);
  await Effect.runPromise(ctx.db\`INSERT INTO late_request VALUES('finished')\`);
  await Bun.write(root + "/finished", "finished");
  return new Response("finished");
 }});
}
`,
	);
	const child = spawn("bun", [join(source, "server.ts")], {
		env: {
			...process.env,
			PORT: "0",
			BOOT_SECRET: "drain-test-secret",
			WRITER_EPOCH: "drain-test",
			APP_DATABASE: join(fixture.root, "comms.db"),
			PAGES_DIRECTORY: join(fixture.root, "pages"),
			STATE: "rehearsal",
			REHEARSAL_SEQUENCE: "10000",
			GENERATION: "100",
			TEST_REQUEST_DIRECTORY: fixture.root,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	test.onTestFinished(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	});
	let output = "";
	const capture = (data: Buffer) => {
		output += data.toString();
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	await expect.poll(() => (/COMMS_CHILD_PORT=(\d+)/.test(output) ? "ready" : output), { timeout: 5000 }).toBe("ready");
	const port = /COMMS_CHILD_PORT=(\d+)/.exec(output)?.[1];
	const url = `http://127.0.0.1:${port}`;
	const secret = { "x-boot-secret": "drain-test-secret" };
	const control = (action: string) =>
		fetch(`${url}/_kernel/control`, {
			method: "POST",
			headers: { ...secret, "content-type": "application/json" },
			body: JSON.stringify({ action }),
		});
	await expect.poll(async () => (await fetch(`${url}/health`, { headers: secret })).status).toBe(200);
	expect((await control("live")).status).toBe(200);
	const identity = {
		...secret,
		"x-comms-agent": "codex",
		"x-comms-instance": "family",
		"x-comms-auth-kind": "agent",
		"x-comms-scopes": "read",
		"x-comms-request-id": "held",
	};
	const aborted = new AbortController();
	const pending = fetch(`${url}/api/late-write`, { headers: identity, signal: aborted.signal }).catch(() => null);
	await expect.poll(() => readFile(join(fixture.root, "started"), "utf8").catch(() => "")).toBe("started");
	aborted.abort();
	await pending;
	let drained = false;
	const drain = control("draining").then(async (response) => {
		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		drained = true;
		return body;
	});
	await expect.poll(async () => (await fetch(`${url}/api/topics`, { headers: identity })).status).toBe(503);
	await delay(150);
	expect(drained).toBe(false);
	expect(await fixture.sql("SELECT value FROM late_request")).toEqual([]);
	await writeFile(join(fixture.root, "release"), "release");
	expect(await drain).toMatchObject({ state: "draining", mutations: 0, requests: 0 });
	expect(await readFile(join(fixture.root, "finished"), "utf8")).toBe("finished");
	expect(await fixture.sql("SELECT value FROM late_request")).toEqual([{ value: "finished" }]);
}, 20000);
