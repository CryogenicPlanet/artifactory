import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { EventRecord } from "@comms/protocol/events";
import { type BootChannel, KernelError } from "./boot-channel.ts";
import { writerGate } from "./database.ts";
import { poisonUncertainWriter } from "./lifecycle.ts";

const Transactions = Schema.Array(Schema.Struct({ transaction_id: Schema.String }));
const Range = Schema.Array(Schema.Struct({ from_seq: Schema.Int, to_seq: Schema.Int, count: Schema.Int }));
const Rows = Schema.Array(
	Schema.Struct({
		seq: Schema.Int,
		event: Schema.fromJsonString(EventRecord),
		shipped_at: Schema.NullOr(Schema.Int),
	}),
);

/** Caller holds the mutation permit. Publication acknowledgement precedes removal of complete SQL evidence. */
export const makeOutboxRelay = (sql: SqlClient, boot: BootChannel["Service"]) => {
	const batch = (id: string) =>
		Effect.gen(function* () {
			const [record] = yield* sql`SELECT from_seq,to_seq,count FROM mutation_batches WHERE id=${id}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Range)),
			);
			const rows =
				yield* sql`SELECT seq,event,shipped_at FROM outbox WHERE transaction_id=${id} ORDER BY seq LIMIT 257`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
				);
			if (
				!record ||
				record.count < 1 ||
				record.count > 256 ||
				record.to_seq - record.from_seq + 1 !== record.count ||
				rows.length !== record.count ||
				rows.some((row, index) => row.seq !== record.from_seq + index || row.event.seq !== row.seq)
			)
				return yield* new KernelError({ code: "batch_missing" });
			return {
				transaction: id,
				from: record.from_seq,
				to: record.to_seq,
				events: rows.map((row) => row.event),
				shipped: rows.every((row) => row.shipped_at !== null),
			};
		});
	const remove = (id: string) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, boot.epoch);
				yield* sql`DELETE FROM outbox WHERE transaction_id=${id}`;
			}),
		);
	return Effect.gen(function* () {
		while (true) {
			const [row] = yield* sql`SELECT transaction_id FROM outbox WHERE shipped_at IS NULL ORDER BY seq LIMIT 1`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Transactions)),
			);
			if (!row) break;
			const item = yield* batch(row.transaction_id);
			const acknowledged = yield* boot.append({
				transaction: item.transaction,
				from: item.from,
				to: item.to,
				events: item.events,
			});
			if (acknowledged.published_through < item.to) return yield* new KernelError({ code: "boot_unavailable" });
			yield* remove(item.transaction);
		}
		// Upgrade backlog already carries durable acknowledgement timestamps. Limit work per relay pass.
		for (let count = 0; count < 16; count++) {
			const [row] = yield* sql`SELECT transaction_id FROM outbox ORDER BY seq LIMIT 1`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Transactions)),
			);
			if (!row) break;
			const item = yield* batch(row.transaction_id);
			if (!item.shipped) return yield* new KernelError({ code: "batch_missing" });
			yield* remove(item.transaction);
		}
		const now = yield* Clock.currentTimeMillis;
		// Idle relay passes need no writer lock when there is nothing to expire.
		const expired = yield* sql`SELECT rowid FROM idempotency WHERE expires_at<=${now}
			AND NOT EXISTS(SELECT 1 FROM outbox) LIMIT 1`;
		if (expired.length === 0) return;
		// Conservatively protect every receipt while any durable publication evidence remains.
		// The epoch gate prevents an old generation from pruning a replacement writer's receipts.
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* writerGate(sql, boot.epoch);
				yield* sql`DELETE FROM idempotency WHERE rowid IN (
			SELECT rowid FROM idempotency WHERE expires_at<=${now}
			AND NOT EXISTS(SELECT 1 FROM outbox) ORDER BY expires_at,rowid LIMIT 256
		)`;
			}),
		);
	}).pipe(Effect.tapCause(poisonUncertainWriter));
};
