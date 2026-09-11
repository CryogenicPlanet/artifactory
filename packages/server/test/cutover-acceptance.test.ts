/* oxlint-disable effecttsgo/global-date -- Opt-in real-process acceptance measures monotonic HTTP latency. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const Message = Schema.Struct({ id: Schema.String, seq: Schema.Int, body: Schema.String });
const Refusal = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const Swap = Schema.Struct({
	status: Schema.String,
	generation: Schema.Int,
	freeze_ms: Schema.optionalKey(Schema.Number),
});
/** Explicit opt-in: measurements belong to acceptance artifacts, not ordinary regression timing. */
it.skipIf(process.env.COMMS_CUTOVER_ACCEPTANCE !== "1")(
	"measures real-kernel traffic across healthy and rejected edits",
	async (test) => {
		const artifact = process.env.COMMS_ACCEPTANCE_REPORT;
		if (!artifact) throw new Error("Set COMMS_ACCEPTANCE_REPORT to a persistent artifact path.");
		const fixture = await conversation(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const records: Array<{
			phase: string;
			method: string;
			status: number | null;
			ms: number;
			code?: string;
			error?: string;
		}> = [];
		const accepted: Array<{ key: string; message: typeof Message.Type }> = [];
		const swaps: Array<{ phase: string; ms: number; outcome: typeof Swap.Type }> = [];
		let running = true,
			phase = "baseline",
			next = 0;
		let failure: unknown;
		const observe = async (method: "GET" | "POST") => {
			const key = `acceptance-${++next}`,
				body = `measured ${key}`,
				current = phase,
				started = performance.now();
			let status: number | null = null;
			try {
				const response = await fetch(
					`${app.url}/api/messages${method === "GET" ? "?topic=acceptance&since=0&mark=0" : ""}`,
					{
						method,
						headers: {
							cookie,
							origin: "https://comms.test",
							"content-type": "application/json",
							"Idempotency-Key": key,
						},
						...(method === "POST" ? { body: JSON.stringify({ topic: "acceptance", body }) } : {}),
						signal: AbortSignal.timeout(30000),
					},
				);
				status = response.status;
				const result: unknown = await response.json();
				if (response.status === 200) {
					if (method === "POST") accepted.push({ key, message: Schema.decodeUnknownSync(Message)(result) });
					records.push({ phase: current, method, status, ms: performance.now() - started });
				} else
					records.push({
						phase: current,
						method,
						status,
						ms: performance.now() - started,
						code: Schema.decodeUnknownSync(Refusal)(result).error.code,
					});
			} catch (error) {
				records.push({
					phase: current,
					method,
					status,
					ms: performance.now() - started,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		const traffic = async (method: "GET" | "POST") => {
			while (running) {
				await observe(method);
				await delay(100);
			}
		};
		const readers = traffic("GET"),
			writers = traffic("POST");
		test.onTestFinished(async () => {
			running = false;
			await Promise.all([readers, writers]);
		});
		try {
			await delay(500);
			expect((await app.post("/_boot/lock", {}, cookie)).status).toBe(200);
			const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
			for (const [name, content] of [
				["healthy", source + "\n// acceptance healthy source change\n"],
				["bad-edit", "this is invalid TypeScript !"],
				["repair", source],
			] as const) {
				phase = name;
				const staged = await fetch(`${app.url}/_boot/fs/app/server.ts?reload=0`, {
					method: "PUT",
					headers: { cookie, origin: "https://comms.test" },
					body: content,
					signal: AbortSignal.timeout(30000),
				});
				expect(staged.status).toBe(200);
				const started = performance.now(),
					response = await fetch(`${app.url}/_boot/reload`, {
						method: "POST",
						headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.timeout(60000),
					});
				expect(response.status).toBe(200);
				const outcome = Schema.decodeUnknownSync(Swap)(await response.json());
				swaps.push({ phase: name, ms: performance.now() - started, outcome });
				expect(outcome.status).toBe(name === "bad-edit" ? "failed" : "live");
			}
			phase = "after";
			await delay(500);
		} catch (error) {
			failure = error;
		} finally {
			running = false;
			await Promise.all([readers, writers]);
		}
		const sorted = records.map((record) => record.ms).sort((a, b) => a - b);
		const summary = {
			runtime: process.version,
			requests: records.length,
			acknowledged_posts: accepted.length,
			observed_refusals: records.filter((record) => record.status !== 200),
			safety_verified: false,
			statuses: records.reduce<Record<string, number>>((counts, record) => {
				const key = String(record.status);
				counts[key] = (counts[key] ?? 0) + 1;
				return counts;
			}, {}),
			latency_ms: {
				p50: sorted[Math.floor(sorted.length * 0.5)],
				p95: sorted[Math.floor(sorted.length * 0.95)],
				p99: sorted[Math.floor(sorted.length * 0.99)],
				max: sorted.at(-1),
			},
			swaps,
			records,
		};

		await writeFile(
			artifact,
			JSON.stringify({ ...summary, operation_failure: failure instanceof Error ? failure.message : failure }, null, 2),
		);
		if (failure !== undefined) throw failure;
		try {
			// Every result is retained. A documented SQL-window refusal is not a transport drop, nor a success.
			expect(records.filter((record) => record.error !== undefined)).toEqual([]);
			expect(
				records.filter(
					(record) =>
						record.status !== 200 &&
						!(record.method === "GET" && record.status === 503 && record.code === "boot_unavailable"),
				),
			).toEqual([]);
			expect(accepted.length).toBeGreaterThan(0);
			expect(await fixture.sql("SELECT id,seq,body FROM messages WHERE topic='acceptance' ORDER BY seq")).toEqual(
				accepted.map((item) => item.message).sort((a, b) => a.seq - b.seq),
			);
			for (const item of accepted) {
				const replay = await fetch(`${app.url}/api/messages`, {
					method: "POST",
					headers: {
						cookie,
						origin: "https://comms.test",
						"content-type": "application/json",
						"Idempotency-Key": item.key,
					},
					body: JSON.stringify({ topic: "acceptance", body: item.message.body }),
					signal: AbortSignal.timeout(10000),
				});
				expect(replay.status).toBe(200);
				expect(Schema.decodeUnknownSync(Message)(await replay.json())).toEqual(item.message);
			}
			expect(await fixture.sql("SELECT COUNT(*) AS count FROM messages WHERE topic='acceptance'")).toEqual([
				{ count: accepted.length },
			]);
		} catch (error) {
			await writeFile(
				artifact,
				JSON.stringify(
					{ ...summary, verification_failure: error instanceof Error ? error.message : String(error) },
					null,
					2,
				),
			);
			throw error;
		}
		await writeFile(artifact, JSON.stringify({ ...summary, safety_verified: true }, null, 2));
	},
	180000,
);
