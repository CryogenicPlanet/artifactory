import { strict as assert } from "node:assert";
import { Effect, Ref, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { EventRecord } from "@comms/protocol/events";
import { type BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { makeOutboxRelay } from "../../src/kernel/outbox.ts";

export const portableOutboxCase = (
	sql: SqlClient,
	channel: BootChannel["Service"],
	mode: "pending" | "incomplete" | "bounded",
) =>
	Effect.gen(function* () {
		const requested = yield* Ref.make(0);
		const acknowledgements = yield* Ref.make(0);
		const blocked = yield* Ref.make(mode === "pending");
		const boot: BootChannel["Service"] = {
			...channel,
			append: (batch) =>
				Effect.gen(function* () {
					yield* Ref.update(acknowledgements, (count) => count + 1);
					if (yield* Ref.get(blocked)) return yield* new KernelError({ code: "boot_unavailable" });
					return yield* channel.append(batch);
				}),
		};
		const relay = makeOutboxRelay(
			sql,
			boot,
			Ref.update(requested, (count) => count + 1),
		);
		const receipt = (key: string, expires_at: number) => ({
			instance: "instance",
			key,
			kind: "test.changed",
			input_hash: "hash",
			outcome: '"original"',
			expires_at,
		});
		if (mode === "bounded") {
			yield* sql`INSERT INTO idempotency ${sql.insert([...Array.from({ length: 300 }, (_, index) => receipt(`expired-${index}`, 0)), receipt("live", Number.MAX_SAFE_INTEGER)])}`;
			yield* relay;
			assert.equal((yield* sql`SELECT ${sql("key")} FROM idempotency WHERE expires_at=0`).length, 44);
			assert.deepEqual(yield* sql`SELECT outcome,expires_at FROM idempotency WHERE ${sql("key")}='live'`, [
				{ outcome: '"original"', expires_at: Number.MAX_SAFE_INTEGER },
			]);
			assert.equal(yield* Ref.get(requested), 1);
			yield* relay;
			assert.deepEqual(yield* sql`SELECT ${sql("key")},outcome FROM idempotency`, [
				{ key: "live", outcome: '"original"' },
			]);
			assert.equal(yield* Ref.get(requested), 2);
			yield* relay;
			assert.equal(yield* Ref.get(requested), 2);
			assert.equal(yield* Ref.get(acknowledgements), 0);
			return;
		}
		const range = yield* channel.reserve("retained", 2);
		const event = (seq: number): typeof EventRecord.Type => ({
			seq,
			at: 1,
			type: "test.changed",
			level: "info",
			actor: "test",
			instance: "instance",
			generation: 1,
			request_id: null,
			topic: null,
			message_id: null,
			payload: {},
		});
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`INSERT INTO mutation_batches(id,from_seq,to_seq,count) VALUES('retained',${range.from},${range.to},2)`;
				for (const seq of [range.from, range.to])
					yield* sql`INSERT INTO outbox(seq,transaction_id,event,shipped_at) VALUES(${seq},'retained',${JSON.stringify(event(seq))},NULL)`;
				yield* sql`INSERT INTO idempotency ${sql.insert(receipt("expired-pending", 0))}`;
			}),
		);
		if (mode === "incomplete") yield* sql`DELETE FROM outbox WHERE seq=${range.to}`;
		const before = yield* sql`SELECT seq,transaction_id,event,shipped_at FROM outbox ORDER BY seq`;
		const result = yield* relay.pipe(Effect.result);
		assert.equal(result._tag, "Failure");
		if (result._tag === "Failure") {
			assert(Schema.is(KernelError)(result.failure));
			assert.equal(result.failure.code, mode === "pending" ? "boot_unavailable" : "batch_missing");
		}
		assert.deepEqual(yield* sql`SELECT seq,transaction_id,event,shipped_at FROM outbox ORDER BY seq`, before);
		assert.deepEqual(yield* sql`SELECT outcome,expires_at FROM idempotency`, [
			{ outcome: '"original"', expires_at: 0 },
		]);
		assert.deepEqual(yield* sql`SELECT id,from_seq,to_seq,count FROM mutation_batches`, [
			{ id: "retained", from_seq: range.from, to_seq: range.to, count: 2 },
		]);
		assert.equal((yield* channel.fence).published_through, 0);
		assert.equal(yield* Ref.get(acknowledgements), mode === "pending" ? 1 : 0);
		assert.equal(yield* Ref.get(requested), 0);
		if (mode === "pending") {
			yield* Ref.set(blocked, false);
			yield* relay;
			assert.deepEqual(yield* sql`SELECT seq FROM outbox`, []);
			assert.deepEqual(yield* sql`SELECT ${sql("key")} FROM idempotency`, []);
			assert.equal((yield* sql`SELECT id FROM mutation_batches`).length, 1);
			// The reservation marker follows the application range and publishes with it.
			assert.equal((yield* channel.fence).published_through, range.to + 1);
			assert.equal(
				(yield* channel.events({ since: 0, limit: 10 })).items.filter((item) => item.type === "test.changed").length,
				2,
			);
			assert.equal(yield* Ref.get(acknowledgements), 2);
		}
	});
