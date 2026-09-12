import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { BunServices } from "@effect/platform-bun";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { writerGate } from "../../src/kernel/database.ts";
import { initializeRemoteBootSchema } from "../../../boot/src/remote-boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { EditLock, layer as editLayer } from "../../../boot/src/edit-lock.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const [mode, filename, identity = ""] = process.argv.slice(2);
if (!filename) throw new Error("Missing disposable configuration");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (!/^comms_concurrency_(app|boot)$/.test(settings.database))
	throw new Error("Disposable concurrency database required");
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const barrier = Effect.promise(async () => {
	const line = await lines.next();
	assert.equal(line.value, "go");
});
const emit = (value: unknown) => Effect.sync(() => process.stdout.write(`${JSON.stringify(value)}\n`));
// SQL contention fixture only: no keeper or lifecycle proof is claimed by this local ACK.
const client = guardianClientLayer({
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "c".repeat(64),
	register: () => Effect.void,
});
const main = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	if (mode === "initialize") {
		if (settings.database.endsWith("boot")) yield* initializeRemoteBootSchema(sql, settings.engine);
		else {
			yield* sql`CREATE TABLE kernel_writer (singleton INTEGER PRIMARY KEY, epoch VARCHAR(64) NOT NULL)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,'stale')`;
			yield* sql`CREATE TABLE concurrency_writes (id VARCHAR(64) PRIMARY KEY)`;
		}
		return;
	}
	if (mode === "inspect") {
		if (settings.database.endsWith("app")) {
			assert.deepEqual(yield* sql`SELECT id FROM concurrency_writes`, [{ id: "current" }]);
		} else {
			const state = yield* sql`SELECT pending_id,pending_from,pending_to,${sql("next")} FROM seq`;
			assert.equal(state[0]?.pending_id, "reservation");
			assert.equal(state[0]?.pending_from, state[0]?.pending_to);
			const events = yield* sql`SELECT seq,type FROM events ORDER BY seq`;
			const boot = events.find((event) => event.type === "concurrency.boot");
			assert.ok(boot);
			assert.notEqual(boot.seq, state[0]?.pending_from);
			assert.equal((yield* sql`SELECT id FROM event_batches WHERE state='pending'`).length, 1);
			assert.equal((yield* sql`SELECT id FROM edit_lock`).length, 1);
			assert.equal(events.filter((event) => event.type === "lock.acquired").length, 1);
			assert.equal(state[0]?.next, 5);
			assert.deepEqual([...events.map((event) => event.seq), state[0]?.pending_from].sort(), [1, 2, 3, 4]);
		}
		return;
	}
	if (mode === "waiting") {
		const ids = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)))(identity);
		yield* Effect.gen(function* () {
			// Bounded database observation is the barrier; elapsed time is never lock evidence.
			while (true) {
				const rows =
					settings.engine === "pg"
						? yield* sql`SELECT pid AS id FROM pg_stat_activity WHERE wait_event_type='Lock' AND ${sql.in("pid", ids)}`
						: yield* sql`SELECT DISTINCT t.PROCESSLIST_ID AS id FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE ${sql.in("PROCESSLIST_ID", ids)}`;
				if (new Set(rows.map((row) => row.id)).size === ids.length) return;
				// Back off unsuccessful observation only; this delay never admits a contender.
				yield* Effect.sleep("10 millis");
			}
		}).pipe(Effect.timeout("10 seconds"));
		return;
	}
	const ready = Effect.gen(function* () {
		const rows =
			settings.engine === "pg" ? yield* sql`SELECT pg_backend_pid() AS id` : yield* sql`SELECT CONNECTION_ID() AS id`;
		yield* emit({ ready: true, pid: process.pid, connection: rows[0]?.id });
		yield* barrier;
	});
	if (mode === "block") {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`SELECT singleton FROM seq WHERE singleton=1 FOR UPDATE`;
				yield* emit({ held: true });
				yield* barrier;
			}),
		);
		return;
	}
	if (mode === "fence") {
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* ready;
					if (identity === "current") yield* sql`UPDATE kernel_writer SET epoch='current' WHERE singleton=1`;
					yield* writerGate(sql, identity);
					yield* sql`INSERT INTO concurrency_writes VALUES(${identity})`;
					yield* emit({ held: true });
					yield* barrier;
				}),
			)
			.pipe(Effect.result);
		if (identity === "stale") {
			assert.equal(result._tag, "Failure");
			if (result._tag === "Failure") {
				assert.ok("code" in result.failure);
				assert.equal(result.failure.code, "stale_writer");
			}
		} else assert.equal(result._tag, "Success");
		yield* emit({ result: identity });
	} else {
		yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* ready;
					const events = yield* Events;
					if (mode === "reserve") yield* events.reserve("reservation", 1, "attempt");
					else if (mode === "event")
						yield* events.writeBoot({
							at: 1,
							type: "concurrency.boot",
							level: "info",
							actor: "boot",
							instance: null,
							generation: 0,
							request_id: null,
							topic: null,
							message_id: null,
							payload: {},
						});
					else if (mode === "lock") {
						const result = yield* (yield* EditLock).acquire(identity, identity).pipe(Effect.result);
						if (result._tag === "Failure") {
							assert.ok("code" in result.failure);
							assert.equal(result.failure.code, "locked");
						}
						yield* emit({ acquired: result._tag === "Success" });
					} else throw new Error("Unknown fixture operation");
				}),
			)
			.pipe(Effect.provide(editLayer), Effect.provide(eventsLayer(Effect.void)));
	}
}).pipe(Effect.provide(client), Effect.provide(BunServices.layer), Effect.scoped);
try {
	await Effect.runPromise(main);
	process.stdout.write('{"done":true}\n');
} finally {
	input.close();
}
