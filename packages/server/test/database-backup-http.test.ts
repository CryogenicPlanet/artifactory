import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it(
	"authenticates manual copies, preserves acknowledged writes and returns only completed metadata",
	{ timeout: 30000 },
	async (test) => {
		const fixture = await conversation(test);
		const app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		expect((await app.post("/api/messages", { topic: "backup", body: "preserved" }, cookie)).status).toBe(200);
		const writer = await fixture.sql("SELECT * FROM kernel_writer");
		const post = (headers: Record<string, string>, body = "{}", query = "") =>
			fetch(`${app.url}/_boot/db/backup${query}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body,
			});
		expect((await post({})).status).toBe(401);
		expect((await post({ cookie })).status).toBe(403);
		expect((await post({ cookie, origin: "https://evil.test" })).status).toBe(403);
		const human = { cookie, origin: "https://comms.test" };
		expect((await post(human, '{"path":"outside.db"}')).status).toBe(400);
		expect((await post(human, "{}", "?extra=1")).status).toBe(400);
		expect((await post({ ...human, "x-boot-secret": "wrong" })).status).toBe(403);
		for (const [token, scope] of [
			["a".repeat(43), "read"],
			["b".repeat(43), "fs"],
		] as const) {
			const hash = createHash("sha256").update(token).digest("hex");
			await fixture.sql(
				`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at)
		 VALUES('${scope}','${scope}','${scope}','fixture','access','${hash}','fixture','["${scope}"]',9999999999999,1)`,
				"boot.db",
			);
		}
		expect((await post({ authorization: `Bearer ${"a".repeat(43)}` })).status).toBe(403);
		expect(await fixture.sql("SELECT id FROM backups", "boot.db")).toEqual([]);
		for (const headers of [human, { authorization: `Bearer ${"b".repeat(43)}` }]) {
			const response = await post(headers);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const record = await response.json();
			expect(Object.keys(record).sort()).toEqual([
				"bytes",
				"generation",
				"id",
				"published_through",
				"reason",
				"taken_at",
			]);
			expect(record.reason).toBe("manual");
			expect(record.bytes).toBeGreaterThan(0);
			expect(await fixture.sql("SELECT body FROM messages", join("backups", basename(`${record.id}.db`)))).toEqual([
				{ body: "preserved" },
			]);
			expect(await fixture.sql(`SELECT id FROM backups WHERE id='${record.id}'`, "boot.db")).toEqual([
				{ id: record.id },
			]);
		}
		expect(await fixture.sql("SELECT * FROM kernel_writer")).toEqual(writer);
		expect((await app.post("/api/messages", { topic: "backup", body: "after copies" }, cookie)).status).toBe(200);
		await fixture.sql("INSERT INTO source_batches VALUES('pending',NULL,'fixture',0,'publishing')", "boot.db");
		const refused = await post(human);
		expect(refused.status).toBe(503);
		expect(await refused.json()).toMatchObject({
			error: { code: "backup_failed", retriable: false, hint: expect.stringContaining("may already exist") },
		});
		expect(await fixture.sql("SELECT COUNT(*) count FROM backups", "boot.db")).toEqual([{ count: 2 }]);
	},
);
