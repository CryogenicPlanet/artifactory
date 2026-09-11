import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/kernel/database.ts";
import { Messages, layer as messagesLayer } from "../../src/kernel/messages.ts";
import { Topics, layer as topicsLayer } from "../../src/kernel/topics.ts";
import { Pages, PageRejected, layer as pagesLayer } from "../../src/kernel/pages.ts";
import { readSql } from "../../src/kernel/sql-read.ts";

const program = Effect.gen(function* () {
	const [root, mode = "append-before"] = process.argv.slice(2);
	if (!root) return yield* Effect.die("Missing root");
	const epoch = `sql-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			if (mode === "recover") {
				// Recovery itself must publish the committed evidence before the replacement app starts.
				assert.equal((yield* events.state).pending_id, null);
				assert.equal((yield* events.query({ since: 0, limit: 100, types: ["sql.write"] })).items.length, 1);
			}
			const release = yield* Deferred.make<void>();
			let testing = false;
			let injected = false;
			let reservations = 0;
			let aborts = 0;
			let cachedFence: number | undefined;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] = {
				epoch,
				filename: `${root}/comms.db`,
				generation: mode === "recover" ? 3 : 2,
				backup: Effect.void,
				changed: () => Effect.never,
				fence: events.state.pipe(
					Effect.map((state) => ({ published_through: cachedFence ?? state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						reservations++;
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						if (testing && !injected && mode.startsWith("reserve-")) {
							injected = true;
							return yield* unavailable();
						}
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						if (testing && !injected) {
							injected = true;
							if (mode === "crash") {
								yield* Console.log("SQL_COMMITTED_UNPUBLISHED");
								yield* Deferred.await(release);
							}
							if (mode === "append-before") return yield* unavailable();

							if (mode === "append-lost") {
								yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
								return yield* unavailable();
							}
						}
						return yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
					}),
				abort: (transaction) =>
					Effect.gen(function* () {
						aborts++;
						yield* events.abort(transaction, epoch).pipe(Effect.mapError(unavailable));
					}),
			};
			return yield* Effect.gen(function* () {
				yield* initialize;
				return yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const messages = yield* Messages;
					const pages = yield* Pages;
					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(`${root}/pages/repair`, { recursive: true });
					yield* fs.writeFileString(`${root}/pages/repair/index.md`, "# Repair");
					const topics = yield* Topics;
					const who = { agent: "human", instance: "session", request: `request-${mode}`, kind: "human" as const };
					const initial = yield* messages.create(who, { topic: "repair", body: "before" }, "seed");
					const input = {
						sql: "UPDATE messages SET body=? WHERE id=? RETURNING body",
						params: ["repaired", initial.id],
					};
					const pendingReads = Effect.gen(function* () {
						for (const work of [
							messages.get(initial.id).pipe(Effect.asVoid),
							messages.list({ since: 0, limit: 10 }).pipe(Effect.asVoid),
							topics.detail(who, "missing-page").pipe(Effect.asVoid),
						]) {
							const result = yield* work.pipe(Effect.result);
							assert.equal(result._tag, "Failure");
							if (result._tag === "Failure")
								assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, "sql_publication_pending");
						}
						const page = yield* pages.read("repair/index.md").pipe(Effect.result);
						assert.equal(page._tag, "Failure");
						if (page._tag === "Failure")
							assert.equal(Schema.is(PageRejected)(page.failure) && page.failure.code, "pages_unavailable");
						const topic = yield* topics.detail(who, "repair").pipe(Effect.result);
						assert.equal(topic._tag, "Failure");
						if (topic._tag === "Failure")
							assert.equal(Schema.is(KernelError)(topic.failure) && topic.failure.code, "sql_publication_pending");
						assert.deepEqual(
							(yield* readSql({ sql: "SELECT body FROM messages WHERE id=?", params: [initial.id] })).rows,
							[{ body: "repaired" }],
						);
					});
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER refuse_sql BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='sql.write' BEGIN SELECT RAISE(ABORT,'failure'); END`;
					testing = mode !== "recover";
					if (mode !== "recover") {
						const result = yield* messages.writeSql(who, input, "repair").pipe(Effect.result);
						assert.equal(result._tag, "Failure");
						assert.equal(aborts, mode === "reserve-lost" || mode === "sql-failure" ? 1 : 0);
						if (mode === "append-before") yield* pendingReads;
						else assert.equal((yield* messages.get(initial.id)).body, mode === "append-lost" ? "repaired" : "before");
						if (mode === "reserve-lost" || mode === "sql-failure") {
							assert.equal((yield* sql`SELECT * FROM idempotency WHERE kind='sql.write'`).length, 0);
							assert.equal((yield* sql`SELECT * FROM outbox WHERE json_extract(event,'$.type')='sql.write'`).length, 0);
							assert.equal((yield* events.state).pending_id, null);
						}
						if (mode === "sql-failure") yield* sql`DROP TRIGGER refuse_sql`;
					}
					const outcome = yield* messages.writeSql(who, input, "repair");
					assert.deepEqual(outcome.rows, [{ body: "repaired" }]);
					assert.ok(outcome.changes > 0);
					assert.equal((yield* messages.get(initial.id)).body, "repaired");
					assert.equal((yield* topics.detail(who, "repair")).messages[0]?.body, "repaired");
					const published = (yield* events.query({ since: 0, limit: 100, types: ["sql.write"] })).items;
					assert.equal(published.length, 1);
					assert.equal(published[0]?.seq, outcome.seq);
					assert.equal(published[0]?.instance, who.instance);
					assert.equal(published[0]?.generation, 2);
					assert.equal((yield* sql`SELECT seq FROM outbox WHERE shipped_at IS NULL`).length, 0);
					// Replaying an old request returns its first result, even after later domain edits.
					yield* messages.update(who, initial.id, { body: "later" });
					const count = reservations;
					assert.deepEqual(yield* messages.writeSql({ ...who, request: "new-request" }, input, "repair"), outcome);
					assert.equal((yield* messages.get(initial.id)).body, "later");
					assert.equal(reservations, count);
					const conflict = yield* messages
						.writeSql(who, { ...input, params: ["different", initial.id] }, "repair")
						.pipe(Effect.result);
					assert.equal(conflict._tag, "Failure");
					if (conflict._tag === "Failure")
						assert.equal(Schema.is(KernelError)(conflict.failure) && conflict.failure.code, "idempotency_conflict");
					const before = yield* events.state;
					cachedFence = outcome.seq - 1;
					assert.ok(cachedFence < outcome.seq);
					yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
					assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
					for (const work of [
						messages.get(initial.id).pipe(Effect.asVoid),
						messages.list({ since: 0, limit: 10 }).pipe(Effect.asVoid),
						topics.detail(who, "missing-page").pipe(Effect.asVoid),
					]) {
						const stale = yield* work.pipe(Effect.result);
						assert.equal(stale._tag, "Failure");
						if (stale._tag === "Failure")
							assert.equal(Schema.is(KernelError)(stale.failure) && stale.failure.code, "stale_writer");
					}
					assert.equal((yield* pages.read("repair/index.md").pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* topics.detail(who, "repair").pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* messages.writeSql(who, input, "stale").pipe(Effect.result))._tag, "Failure");
					assert.equal(reservations, count);
					assert.deepEqual(yield* events.state, before);
					assert.deepEqual(
						(yield* readSql({ sql: "SELECT body FROM messages WHERE id=?", params: [initial.id] })).rows,
						[{ body: "later" }],
					);
					yield* Console.log("SQL_WRITE_RECOVERED");
				}).pipe(
					Effect.provide(
						topicsLayer.pipe(Layer.provideMerge(pagesLayer(`${root}/pages`)), Layer.provideMerge(messagesLayer)),
					),
				);
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
