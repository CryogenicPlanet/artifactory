import { sourcePut } from "./fixtures/source-put.ts";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { launcherOutput } from "./fixtures/launcher-diagnostics.ts";
import { seedSession, sessionFetch } from "./fixtures/session.ts";

it.for([false, true, "configured"] as const)(
	"restarts below headroom with cleared grants=%s, serving saved data and refusing live writes",
	{ timeout: 30000 },
	async (clearGrants, test) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-storage-startup-"));
		test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const seed = join(directory, "seed");
		await cp(join(import.meta.dirname, "../../server/src"), seed, { recursive: true });
		await writeFile(
			join(seed, "ext/broken.ts"),
			'export default function () { throw new Error("fixture extension failure"); }',
		);

		const processes: ReturnType<typeof spawn>[] = [];
		const stop = async (child: ReturnType<typeof spawn>) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			const force = setTimeout(() => child.kill("SIGKILL"), 5000);
			try {
				await exited;
			} finally {
				clearTimeout(force);
			}
		};
		test.onTestFinished(async () => {
			for (const child of processes) await stop(child);
		});
		const start = async (mode: "normal" | "low") => {
			const child = spawn("bun", [join(import.meta.dirname, "fixtures/storage-launcher.ts"), mode], {
				env: { ...process.env, ENTRY: join(seed, "server.ts"), DATA_DIR: directory },
				stdio: ["ignore", "pipe", "pipe"],
			});
			processes.push(child);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-16384);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-16384);
			});
			let url = "";
			await expect
				.poll(
					() => {
						if (child.exitCode !== null) throw new Error(output);
						url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
						return url;
					},
					{ timeout: 5000 },
				)
				.not.toBe("");
			const { cookie } = await seedSession(directory);
			const request = sessionFetch(cookie);
			const status = async () => {
				const response = await request(`${url}/_boot/status`);
				const body: unknown = await response.json();
				if (
					typeof body !== "object" ||
					body === null ||
					!("child" in body) ||
					typeof body.child !== "object" ||
					body.child === null ||
					!("state" in body.child) ||
					!("generation" in body.child)
				)
					throw new Error("Invalid boot status");
				if (body.child.state === "failed") throw new Error(JSON.stringify(body));
				return body.child;
			};
			await expect.poll(async () => (await status()).state, { timeout: 10000 }).toBe("live");
			return {
				child,
				request,
				url,
				generation: (await status()).generation,
				diagnostic: () => ({
					...launcherOutput(output),
					event_maintenance_failed: output.includes("Event page-budget maintenance failed; retrying next minute"),
				}),
			};
		};
		const first = await start("normal");
		await expect
			.poll(async () => (await first.request(`${first.url}/api/events?since=0&types=ext.failed`)).text())
			.toContain("broken.ts");

		const created = await first.request(`${first.url}/api/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"topic":"saved","body":"durable before low space"}',
		});

		expect(created.status).toBe(200);
		expect(
			(
				await first.request(`${first.url}/api/topics/saved`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: '{"meta":{"public":true}}',
				})
			).status,
		).toBe(200);
		await mkdir(join(directory, "pages/saved"), { recursive: true });
		await writeFile(join(directory, "pages/saved/readme.md"), "# Saved public page");
		expect(
			(
				await first.request(`${first.url}/api/messages`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: '{"topic":"private","body":"private"}',
				})
			).status,
		).toBe(200);
		await mkdir(join(directory, "pages/private"), { recursive: true });
		await writeFile(join(directory, "pages/private/readme.md"), "# Private page");

		expect((await fetch(`${first.url}/p/saved/readme.md`)).status).toBe(200);

		await stop(first.child);
		if (clearGrants === true) {
			// Database restore deliberately clears this projection before activation reconstructs it.
			await promisify(execFile)("bun", [
				join(import.meta.dirname, "fixtures/store.ts"),
				join(directory, "boot.db"),
				"DELETE FROM public_paths",
			]);
		}

		if (clearGrants === "configured") {
			await promisify(execFile)("bun", [
				join(import.meta.dirname, "fixtures/store.ts"),
				join(directory, "boot.db"),
				`INSERT INTO settings VALUES('storage_policy','{"backup_percent":20,"event_percent":10,"headroom_percent":60}')`,
			]);
		}
		const restarted = await start(clearGrants === "configured" ? "normal" : "low");
		expect(restarted.generation).toBe(first.generation);
		const publicRead = await fetch(`${restarted.url}/p/saved/readme.md`);
		expect(publicRead.status).toBe(200);
		expect(await publicRead.text()).toContain("Saved public page");
		expect((await fetch(`${restarted.url}/p/private/readme.md`)).status).toBe(401);
		const read = await restarted.request(`${restarted.url}/api/messages?topic=saved&since=0`);
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ items: [{ body: "durable before low space" }] });
		const refused = await restarted.request(`${restarted.url}/api/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"topic":"saved","body":"must refuse"}',
		});
		expect(refused.status).toBe(507);
		expect(await refused.json()).toMatchObject({ error: { code: "storage_headroom" } });
		if (clearGrants === "configured") {
			const page = `${restarted.url}/api/fs/pages/saved/readme.md`;
			const deniedPage = await sourcePut(page, { method: "PUT", body: "must preserve page" }, restarted.request);
			expect(deniedPage.status).toBe(507);
			expect(await deniedPage.json()).toMatchObject({ error: { code: "storage_headroom" } });
			expect(await (await restarted.request(page)).text()).toContain("Saved public page");
			expect(
				(await restarted.request(`${restarted.url}/api/fs/pages/private/readme.md`, { method: "DELETE" })).status,
			).toBe(200);
			await promisify(execFile)("bun", [
				join(import.meta.dirname, "fixtures/store.ts"),
				join(directory, "boot.db"),
				`UPDATE settings SET value='{"backup_percent":20,"event_percent":10,"headroom_percent":5}' WHERE key='storage_policy'`,
			]);
			const admitted = await restarted.request(`${restarted.url}/api/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"topic":"saved","body":"after policy change without restart"}',
			});
			expect(
				admitted.status,
				admitted.status === 200
					? undefined
					: JSON.stringify({ response: (await admitted.clone().text()).slice(0, 4096), boot: restarted.diagnostic() }),
			).toBe(200);
			const send = () => sourcePut(page, { method: "PUT", body: "after policy change" }, restarted.request);
			const pending = Schema.Struct({
				error: Schema.Struct({ code: Schema.Literals(["publication_pending"]), retriable: Schema.Literals([true]) }),
			});
			let repaired = await send();
			// A live background reservation can refuse raw publication before its journal exists.
			// Retry only that explicit refusal after capacity is restored, never an uncertain write.
			await expect
				.poll(
					async () => {
						if (repaired.status === 503 && Schema.is(pending)(await repaired.clone().json())) repaired = await send();
						return repaired.status;
					},
					{ timeout: 2000, interval: 20 },
				)
				.toBe(200);
			expect(await (await restarted.request(page)).text()).toBe("after policy change");
			expect(await (await restarted.request(`${restarted.url}/api/messages?topic=saved&since=0`)).json()).toMatchObject(
				{
					items: [{ body: "durable before low space" }, { body: "after policy change without restart" }],
				},
			);
		}
	},
);
