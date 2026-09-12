import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";

const program = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const epoch = "search-epoch";
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			let failAppend = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] & { readonly filename: string } = {
				epoch,
				store: { _tag: "file", filename: `${root}/comms.db` },
				filename: `${root}/comms.db`,
				generation: 1,
				backup: Effect.void,
				changed: (after) =>
					events.changed(after).pipe(Effect.mapError(() => new KernelError({ code: "boot_unavailable" }))),
				fence: events.state.pipe(
					Effect.map((state) => ({ published_through: state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (id, count) => events.reserve(id, count, epoch).pipe(Effect.mapError(unavailable)),
				append: (batch) =>
					failAppend ? Effect.fail(unavailable()) : events.append(batch, epoch).pipe(Effect.mapError(unavailable)),
				abort: (id) => events.abort(id, epoch).pipe(Effect.mapError(unavailable)),
			};
			return yield* Effect.gen(function* () {
				yield* initialize;
				return yield* Effect.gen(function* () {
					const messages = yield* Messages,
						sql = yield* SqlClient.SqlClient;
					const who = { agent: "rahul", instance: "search", request: "test", kind: "human" as const };
					const original = yield* messages.create(who, {
						topic: "search",
						body: "previous solar phrase",
						tags: ["old"],
					});
					const find = (q: string) => messages.list({ recursive: true, q, since: 0, limit: 10 });
					const filtered = (tag: string, q: string, agent = "rahul") =>
						messages.list({ tag, q, agent, since: 0, limit: 10 });
					const other = yield* messages.create(
						{ ...who, agent: "codex", instance: "other" },
						{ topic: "search", body: "another solar phrase", tags: ["old"] },
					);
					assert.deepEqual((yield* filtered("old", "solar", "codex")).items, [other]);
					assert.equal(
						(yield* messages
							.list({ recursive: true, q: "solar", since: Number.MAX_SAFE_INTEGER, limit: 10 })
							.pipe(Effect.result))._tag,
						"Failure",
					);
					// Exercise a real schema3 ->4 backfill with an existing message, not just a fresh index.
					yield* sql`DROP TRIGGER messages_fts_insert`;
					yield* sql`DROP TRIGGER messages_fts_update`;
					yield* sql`DROP TRIGGER messages_fts_delete`;
					yield* sql`DROP TABLE messages_fts`;
					yield* sql`ALTER TABLE topics DROP COLUMN updated_seq`;
					yield* sql`ALTER TABLE topics DROP COLUMN previous`;
					yield* sql`ALTER TABLE topics DROP COLUMN deleted_at`;
					yield* sql`DROP TABLE IF EXISTS agents`;
					yield* sql`DROP TABLE kv`;
					yield* sql`DROP TABLE IF EXISTS reactions`;
					yield* sql`DROP TABLE topic_page_continuations`;
					yield* sql`ALTER TABLE messages DROP COLUMN mentions`;
					yield* sql`ALTER TABLE messages DROP COLUMN previous_mentions`;
					yield* sql`DROP INDEX outbox_unshipped`;
					yield* sql`DROP INDEX outbox_transaction`;
					yield* sql`DROP TABLE idempotency`;
					yield* sql`CREATE TABLE idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,message_id TEXT NOT NULL,transaction_id TEXT NOT NULL,outcome TEXT,PRIMARY KEY(instance,key))`;
					yield* sql`CREATE TABLE read_idempotency(instance TEXT NOT NULL,key TEXT NOT NULL,topic TEXT NOT NULL,requested_seq INTEGER NOT NULL,effective_seq INTEGER NOT NULL,PRIMARY KEY(instance,key))`;
					yield* sql`DROP TABLE IF EXISTS core_migrations`;
					yield* sql`PRAGMA user_version = 3`;
					yield* initialize;
					assert.equal((yield* find("solar")).items[0]?.id, original.id);
					failAppend = true;
					assert.equal(
						(yield* messages
							.update(who, original.id, { body: "next lunar phrase", tags: ["new"] }, "edit")
							.pipe(Effect.result))._tag,
						"Failure",
					);
					assert.deepEqual((yield* filtered("old", '"solar phrase"')).items, [original]);
					assert.equal((yield* filtered("new", "lunar")).items.length, 0);
					assert.equal((yield* filtered("new", "solar")).items.length, 0);
					assert.equal((yield* filtered("old", "lunar")).items.length, 0);
					assert.equal((yield* find("lunar")).items.length, 0);
					failAppend = false;
					yield* messages.relay;
					assert.deepEqual((yield* find("solar")).items, [other]);
					assert.equal((yield* filtered("old", "solar")).items.length, 0);
					assert.equal((yield* filtered("new", "lunar")).items[0]?.id, original.id);
					assert.equal((yield* find("lunar")).items[0]?.body, "next lunar phrase");
					failAppend = true;
					assert.equal((yield* messages.remove(who, original.id, "delete").pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* find("lunar")).items[0]?.id, original.id);
					failAppend = false;
					yield* messages.relay;
					assert.equal((yield* find("lunar")).items.length, 0);
					failAppend = true;
					assert.equal(
						(yield* messages.create(who, { topic: "search", body: "pending newborn" }).pipe(Effect.result))._tag,
						"Failure",
					);
					assert.equal((yield* find("newborn")).items.length, 0);
					failAppend = false;
					yield* messages.relay;
					assert.equal((yield* find("newborn")).items.length, 1);
					yield* sql`CREATE TRIGGER reject_search_write BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='message.created' BEGIN SELECT RAISE(ABORT,'rollback'); END`;
					assert.equal(
						(yield* messages.create(who, { topic: "search", body: "uncommitted phantom" }).pipe(Effect.result))._tag,
						"Failure",
					);
					assert.equal((yield* find("phantom")).items.length, 0);
					assert.equal((yield* sql`SELECT * FROM messages_fts WHERE messages_fts MATCH 'phantom'`).length, 0);
					yield* Console.log("SEARCH_PUBLISHED");
				}).pipe(Effect.provide(messagesLayer.pipe(Layer.provideMerge(publicationLayer))));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
