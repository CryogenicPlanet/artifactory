import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const Status = Schema.Struct({
	child: Schema.Struct({ state: Schema.String, pid: Schema.NullOr(Schema.Int), error: Schema.NullOr(Schema.String) }),
});
const Attempt = Schema.Struct({ id: Schema.String, receipt: Schema.String, opened: Schema.Int, closed: Schema.Int });
const Batch = Schema.Struct({ id: Schema.String, state: Schema.String, from_seq: Schema.Int, to_seq: Schema.Int });
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

for (const mode of ["constraint", "trigger"] as const)
	it(`retires the child after an implicit SQLite ${mode} rollback before resuming writes`, async (test) => {
		const fixture = await conversation(test),
			app = await fixture.launch();
		await app.setup();
		const cookie = await app.login();
		await app.ready(cookie);
		const state = async () =>
			Schema.decodeUnknownSync(Status)(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json());
		const oldPid = (await state()).child.pid;
		expect(oldPid).not.toBeNull();
		if (oldPid === null) throw new Error("Missing live child PID");
		const attempts = Schema.decodeUnknownSync(Schema.Array(Attempt))(
			await fixture.sql("SELECT id,receipt,opened,closed FROM child_attempts WHERE opened=1 AND closed=0", "boot.db"),
		);
		expect(attempts).toHaveLength(1);
		const old = attempts[0];
		if (!old) throw new Error("Missing live keeper attempt");
		const oldEpoch = await fixture.sql("SELECT epoch FROM kernel_writer");
		const epoch = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ epoch: Schema.String })))(oldEpoch)[0]?.epoch;
		if (!epoch) throw new Error("Missing writer epoch");
		const previous = await app.post(
			"/api/messages",
			{ topic: "sql-recovery", body: "acknowledged" },
			cookie,
			"previous",
		);
		expect(previous.status).toBe(200);
		const previousOutcome = await previous.json();
		await fixture.sql("CREATE TABLE repair(value INTEGER UNIQUE ON CONFLICT ROLLBACK)");
		const sqlInput = { sql: "INSERT INTO repair VALUES(1) RETURNING value" };
		const seeded = await app.post("/api/sql", sqlInput, cookie, "seed");
		expect(seeded.status).toBe(200);
		const seedOutcome = await seeded.json();
		const originalReceipts = await fixture.sql(
			"SELECT * FROM idempotency WHERE json_extract(key,'$[0]')='key' ORDER BY key",
		);
		const beforeBatches = Schema.decodeUnknownSync(Schema.Array(Batch))(
			await fixture.sql(`SELECT id,state,from_seq,to_seq FROM event_batches WHERE attempt='${epoch}'`, "boot.db"),
		);
		if (mode === "trigger")
			await fixture.sql(
				"CREATE TRIGGER undo_write AFTER INSERT ON repair WHEN new.value=3 BEGIN SELECT RAISE(ROLLBACK,'fixture rollback'); END",
			);
		const failed = await app.post(
			"/api/sql",
			{ sql: mode === "constraint" ? "INSERT INTO repair VALUES(2),(1)" : "INSERT INTO repair VALUES(2),(3)" },
			cookie,
			"failed",
		);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({ error: { code: "handler_failed", retriable: false } });
		// Queued-write refusal is covered deterministically by the shared-mutex regression.
		await expect
			.poll(
				async () => {
					const child = (await state()).child;
					return child.state === "live" && child.pid !== oldPid;
				},
				{ timeout: 12000 },
			)
			.toBe(true);
		expect(alive(oldPid)).toBe(false);
		expect(await fixture.sql(`SELECT opened,closed FROM child_attempts WHERE id='${old.id}'`, "boot.db")).toEqual([
			{ opened: 1, closed: 1 },
		]);
		expect(await readFile(old.receipt, "utf8")).toBe(old.id);
		expect(await fixture.sql("SELECT epoch FROM kernel_writer")).not.toEqual(oldEpoch);
		expect(await fixture.sql("SELECT value FROM repair")).toEqual([{ value: 1 }]);
		expect(await fixture.sql("SELECT body FROM messages WHERE topic='sql-recovery'")).toEqual([
			{ body: "acknowledged" },
		]);
		expect(await fixture.sql("SELECT * FROM idempotency WHERE json_extract(key,'$[0]')='key' ORDER BY key")).toEqual(
			originalReceipts,
		);
		const afterBatches = Schema.decodeUnknownSync(Schema.Array(Batch))(
			await fixture.sql(`SELECT id,state,from_seq,to_seq FROM event_batches WHERE attempt='${epoch}'`, "boot.db"),
		);
		const failedBatches = afterBatches.filter((batch) => !beforeBatches.some((before) => before.id === batch.id));
		expect(failedBatches).toHaveLength(1);
		const failedBatch = failedBatches[0];
		if (!failedBatch) throw new Error("Missing failed transaction reservation");
		expect(failedBatch.state).toBe("aborted");
		expect(await fixture.sql(`SELECT id FROM mutation_batches WHERE id='${failedBatch.id}'`)).toEqual([]);
		expect(await fixture.sql(`SELECT seq FROM outbox WHERE transaction_id='${failedBatch.id}'`)).toEqual([]);
		expect(
			await fixture.sql(
				`SELECT seq FROM events WHERE seq BETWEEN ${failedBatch.from_seq} AND ${failedBatch.to_seq}`,
				"boot.db",
			),
		).toEqual([]);
		expect(await fixture.sql("SELECT pending_id FROM seq", "boot.db")).toEqual([{ pending_id: null }]);
		expect(await (await app.post("/api/sql", sqlInput, cookie, "seed")).json()).toEqual(seedOutcome);
		expect(
			await (
				await app.post("/api/messages", { topic: "sql-recovery", body: "acknowledged" }, cookie, "previous")
			).json(),
		).toEqual(previousOutcome);
		const resumed = await app.post(
			"/api/sql",
			{ sql: "INSERT INTO repair VALUES(4) RETURNING value" },
			cookie,
			"failed",
		);
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toMatchObject({ rows: [{ value: 4 }], changes: 1 });
		expect(await fixture.sql("SELECT value FROM repair ORDER BY value")).toEqual([{ value: 1 }, { value: 4 }]);
	}, 30000);
