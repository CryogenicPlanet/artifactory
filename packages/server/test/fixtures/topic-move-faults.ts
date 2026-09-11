import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Ref, Schema } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, EventRecord, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/kernel/database.ts";
import { Messages, layer as messagesLayer } from "../../src/kernel/messages.ts";
import { extensionData } from "../../src/kernel/extension-data.ts";
import { Lifecycle, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";

const program = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing arguments");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		yield* Effect.gen(function* () {
			const events = yield* Events;
			const bootSql = yield* SqlClient.SqlClient;
			yield* (yield* AppRecovery).prepare(epoch);
			let testing = false;
			let reserveFailed = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] = {
				agents: Effect.succeed({ items: [] }),
				epoch,
				filename: `${root}/comms.db`,
				generation: 1,
				fence: events.state.pipe(
					Effect.map((state) => ({ published_through: state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "reserve-lost" && !reserveFailed) {
							reserveFailed = true;
							return yield* unavailable();
						}
						return range;
					}),
				append: (batch) => events.append(batch, epoch).pipe(Effect.mapError(unavailable)),
				abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			};
			yield* Effect.gen(function* () {
				yield* initialize;
				yield* Effect.gen(function* () {
					const messages = yield* Messages;
					const sql = yield* SqlClient.SqlClient;
					const who = { agent: "codex", instance: "family", request: "request", kind: "human" as const };
					const initial = yield* messages.create(who, { topic: "project/child", body: "retained" }, "create");
					const sibling = yield* messages.create(who, { topic: "project-other", body: "outside" });
					yield* messages.topic(who, "project", { meta: { public: true, status: "active" } }, "meta");
					yield* messages.toggleReaction(who, { message: initial.id, emoji: "ok" }, "reaction");
					yield* messages.mark(who, { topic: "project/child", seq: initial.seq }, "read");
					const reject = <A, E, R>(effect: Effect.Effect<A, E, R>, code?: string) =>
						effect.pipe(
							Effect.result,
							Effect.map((result) => {
								assert.equal(result._tag, "Failure");
								if (code && result._tag === "Failure")
									assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, code);
							}),
						);
					const command = {
						transaction: "move-first",
						from: "project",
						to: "new/project",
						page_source: false,
						identity: who,
						key: "move",
					};
					if (mode === "reserved-event") {
						yield* Ref.set((yield* Lifecycle).state, "live");
						const data = yield* extensionData;
						const before = yield* events.state;
						const outbox = yield* sql`SELECT * FROM outbox ORDER BY seq`;
						yield* reject(
							messages.recordEvent({
								transaction: "a".repeat(32),
								type: "topic.moved",
								level: "info",
								payload: { from: "project", to: "forged" },
							}),
							"input_invalid",
						);
						yield* reject(
							data("forged.ts", who).log("topic.moved", { from: "project", to: "forged" }),
							"input_invalid",
						);
						assert.deepEqual(yield* events.state, before);
						assert.deepEqual(yield* sql`SELECT * FROM outbox ORDER BY seq`, outbox);
						return yield* Console.log("MOVE_VERIFIED");
					}
					const unchanged = Effect.gen(function* () {
						assert.deepEqual(yield* messages.get(initial.id), initial);
						assert.equal((yield* sql`SELECT path FROM topics WHERE path='new/project'`).length, 0);
						assert.equal(
							(yield* sql`SELECT seq FROM outbox WHERE json_extract(event,'$.type')='topic.moved'`).length,
							0,
						);
					});
					if (mode === "validation") {
						const before = yield* events.state;
						for (const [from, to] of [
							["project", "project"],
							["project", "project/descendant"],
							["project/child", "project"],
							["project", "../bad"],
							["missing", "new/project"],
							["project", "project-other"],
							["project", "x".repeat(198)],
						] as const)
							yield* reject(messages.moveTopic({ ...command, from, to }));
						yield* reject(messages.moveTopic({ ...command, key: "" }), "input_invalid");
						assert.deepEqual(yield* events.state, before);
						yield* messages.topic(who, "archived", { meta: {} });
						yield* messages.topic(who, "archived", { archived: true });
						yield* reject(messages.moveTopic({ ...command, to: "archived/new" }));
						yield* reject(messages.moveTopic({ ...command, from: "archived", to: "unused" }));
						yield* messages.topic(who, "deleted", { meta: {} });
						yield* messages.deleteTopic(who, "deleted");
						yield* reject(messages.moveTopic({ ...command, to: "deleted/new" }));
						yield* reject(messages.moveTopic({ ...command, from: "deleted", to: "unused" }));
						yield* unchanged;
						const page = yield* messages.moveTopic({
							...command,
							transaction: "page-only",
							from: "page-only",
							to: "page-moved",
							page_source: true,
						});
						assert.equal(page.to, "page-moved");
						return yield* Console.log("MOVE_VERIFIED");
					}
					if (mode === "ancestors") {
						const remaining = yield* messages.create(who, { topic: "project/remaining", body: "stay here" });
						const move = { ...command, from: "project/child", to: "new/child" };
						const result = yield* messages.moveTopic(move);
						assert.deepEqual(
							yield* sql`SELECT path,last_seq FROM topics WHERE path IN ('project','new','new/child') ORDER BY path`,
							[
								{ path: "new", last_seq: initial.seq },
								{ path: "new/child", last_seq: initial.seq },
								{ path: "project", last_seq: remaining.seq },
							],
						);
						assert.deepEqual(
							yield* messages.moveTopic({
								transaction: move.transaction,
								from: move.from,
								to: move.to,
								identity: who,
								page_source: false,
							}),
							result,
						);
						return yield* Console.log("MOVE_VERIFIED");
					}
					if (mode === "stale") {
						yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
						const before = yield* events.state;
						yield* reject(messages.moveTopic(command), "stale_writer");
						assert.deepEqual(yield* events.state, before);
						yield* unchanged;
						return yield* Console.log("MOVE_VERIFIED");
					}
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER reject_move BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='topic.moved' BEGIN SELECT RAISE(ABORT,'reject'); END`;
					testing = true;
					if (mode === "sql-failure" || mode === "reserve-lost") {
						yield* reject(messages.moveTopic(command));
						yield* unchanged;
						assert.equal((yield* sql`SELECT id FROM mutation_batches WHERE id=${command.transaction}`).length, 0);
						// The boot coordinator resolves a lost reservation only after confirmed app rollback.
						yield* events.reserve(command.transaction, 1, epoch);
						yield* events.abort(command.transaction, epoch);
						if (mode === "sql-failure") yield* sql`DROP TRIGGER reject_move`;
						const result = yield* messages.moveTopic({ ...command, transaction: "move-retry" });
						assert.equal(result.to, "new/project");
						return yield* Console.log("MOVE_VERIFIED");
					}
					const deleted = yield* messages.create(who, { topic: "project/deleted", body: "preserve tombstone" });
					yield* messages.deleteTopic(who, "project/deleted");
					// Read marks can exist without a topic row; merge a destination collision monotonically.
					yield* sql`INSERT INTO reads VALUES('family','new/project/child',${sibling.seq})`;
					const oldEvents = yield* sql`SELECT * FROM outbox ORDER BY seq`;
					const receipts = yield* sql`SELECT * FROM idempotency ORDER BY key`;
					const readReceipts = yield* sql`SELECT * FROM read_idempotency ORDER BY key`;
					const reactions = yield* sql`SELECT * FROM reactions`;
					const state = yield* events.state;
					const result = yield* messages.moveTopic(command);
					assert.equal(result.from, "project");
					assert.equal(result.to, "new/project");
					assert.deepEqual(yield* messages.moveTopic(command), result);
					yield* reject(messages.moveTopic({ ...command, to: "elsewhere" }), "idempotency_conflict");
					yield* reject(messages.moveTopic({ ...command, from: "../invalid" }), "input_invalid");
					assert.equal((yield* events.state).published_through, state.published_through);
					assert.deepEqual(yield* sql`SELECT * FROM outbox WHERE seq<${result.seq} ORDER BY seq`, oldEvents);
					assert.deepEqual(yield* sql`SELECT * FROM idempotency ORDER BY key`, receipts);
					assert.deepEqual(yield* sql`SELECT * FROM read_idempotency ORDER BY key`, readReceipts);
					assert.deepEqual(yield* sql`SELECT * FROM reactions`, reactions);
					assert.deepEqual(yield* sql`SELECT id,seq,topic FROM messages WHERE id=${initial.id}`, [
						{ id: initial.id, seq: initial.seq, topic: "new/project/child" },
					]);
					assert.deepEqual(yield* messages.get(sibling.id), sibling);
					assert.equal(
						(yield* sql`SELECT path FROM topics WHERE path='project' OR substr(path,1,8)='project/'`).length,
						0,
					);
					assert.deepEqual(yield* sql`SELECT path,parent,name FROM topics WHERE path='new/project'`, [
						{ path: "new/project", parent: "new", name: "project" },
					]);
					assert.deepEqual(
						yield* sql`SELECT path,last_seq FROM topics WHERE path IN ('new','new/project') ORDER BY path`,
						[
							{ path: "new", last_seq: deleted.seq },
							{ path: "new/project", last_seq: deleted.seq },
						],
					);
					assert.equal(
						(yield* sql`SELECT path FROM topics WHERE path='new/project/deleted' AND deleted_at IS NOT NULL`).length,
						1,
					);
					assert.deepEqual(yield* sql`SELECT topic,seq FROM reads WHERE instance='family'`, [
						{ topic: "new/project/child", seq: sibling.seq },
					]);
					assert.equal(
						(yield* sql`SELECT seq FROM outbox WHERE json_extract(event,'$.type')='topic.moved' AND shipped_at IS NULL`)
							.length,
						1,
					);
					// Complete boot publication, then reuse the old path before retrying the first command.
					const movedEvents = yield* sql`SELECT event FROM outbox WHERE transaction_id=${command.transaction}`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.fromJsonString(EventRecord) }))),
						),
					);
					assert.deepEqual(movedEvents[0]?.event.payload, { from: command.from, to: command.to });
					yield* bootSql`INSERT INTO topic_moves(id,from_path,to_path,instance,request_key,request_hash,state,seq) VALUES(${command.transaction},${command.from},${command.to},${who.instance},NULL,'test','pages_published',${result.seq})`;
					yield* events.append(
						{
							transaction: command.transaction,
							from: result.seq,
							to: result.seq,
							events: movedEvents.map((row) => row.event),
						},
						epoch,
					);
					const reused = yield* messages.create(who, { topic: "project/child", body: "new content at original path" });
					assert.equal(
						(yield* sql`SELECT seq FROM outbox WHERE transaction_id=${command.transaction} AND shipped_at IS NOT NULL`)
							.length,
						1,
					);
					assert.deepEqual(yield* messages.moveTopic({ ...command, transaction: "new-retry-id" }), result);
					assert.deepEqual(yield* messages.get(reused.id), reused);
					yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
					yield* reject(messages.moveTopic(command), "stale_writer");
					yield* Console.log("MOVE_VERIFIED");
				}).pipe(Effect.provide(Layer.mergeAll(messagesLayer, lifecycleLayer)));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
