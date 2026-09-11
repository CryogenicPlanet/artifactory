import { deleteTopic } from "./optional-topic-delete.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { extensionData } from "../../src/kernel/extension-data.ts";
import { Lifecycle, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { layer as healthLayer } from "../../src/kernel/health-probe.ts";
import { makePageContinuation, pendingPageMove } from "../../src/ext/core/topic-page-continuation.ts";

const program = Effect.gen(function* () {
	const [root, mode, phase] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing arguments");
	const epoch = `epoch-${mode}`;
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(`${root}/pages`, { recursive: true });
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			let testing = false;
			let faulted = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] = {
				epoch,
				filename: `${root}/comms.db`,
				generation: 1,
				backup: Effect.void,
				changed: (after) => events.changed(after).pipe(Effect.mapError(unavailable)),
				fence: events.state.pipe(
					Effect.map((state) => ({ published_through: state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "reserve-lost" && !faulted) {
							faulted = true;
							return yield* unavailable();
						}
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						if (testing && mode === "append-unavailable") return yield* unavailable();
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "append-lost" && !faulted) {
							faulted = true;
							return yield* unavailable();
						}
						return result;
					}),
				abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			};
			yield* Effect.gen(function* () {
				yield* initialize;
				yield* Effect.gen(function* () {
					const messages = yield* Messages;
					const sql = yield* SqlClient.SqlClient;
					const pages = yield* makePageContinuation(`${root}/pages`);
					const who = { agent: "codex", instance: "family", request: "request", kind: "human" as const };
					if (phase === "resume") {
						const [pending] = yield* sql`SELECT seq FROM topic_page_continuations WHERE completed=0`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })))),
						);
						assert.ok(pending);
						assert.equal(yield* fs.readFileString(`${root}/pages/project/index.md`), "replacement");
						const before = (yield* events.query({ since: 0, limit: 100, types: ["topic.moved"] })).items;
						assert.equal(before.length, 1);
						yield* sql`DROP TRIGGER reject_completion`;
						const result = yield* messages.moveTopic(
							who,
							"project",
							"new/project",
							pages,
							mode === "keyless-restart" ? undefined : "move",
						);
						assert.equal(result.seq, pending.seq);
						assert.deepEqual((yield* events.query({ since: 0, limit: 100, types: ["topic.moved"] })).items, before);
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["topic.pages_moved"] })).items.length, 1);
						assert.equal((yield* pendingPageMove(sql, "project")).length, 0);
						assert.equal(yield* fs.readFileString(`${root}/pages/project/index.md`), "replacement");
						assert.equal(yield* fs.readFileString(`${root}/pages/new/project/index.md`), "original");
						assert.deepEqual(
							(yield* messages.list({ since: 0, topic: "project/child", limit: 20 })).items.map((item) => item.body),
							["new source"],
						);
						return;
					}
					const initial = yield* messages.create(who, { topic: "project/child", body: "retained" }, "create");
					const sibling = yield* messages.create(who, { topic: "project-other", body: "outside" });
					yield* messages.topic(who, "project", { meta: { public: true, status: "active" } }, "meta");
					yield* sql`INSERT INTO reactions VALUES(${initial.id},${who.instance},'ok',1,0,${initial.seq})`;
					yield* messages.change(
						sql`INSERT INTO reads VALUES(${who.instance},'project/child',${initial.seq})`.pipe(Effect.asVoid),
					);
					const reject = <A, E, R>(effect: Effect.Effect<A, E, R>, code?: string) =>
						effect.pipe(
							Effect.result,
							Effect.map((result) => {
								assert.equal(result._tag, "Failure");
								if (code && result._tag === "Failure")
									assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, code);
							}),
						);
					const move = (from = "project", to = "new/project", key = "move") =>
						messages.moveTopic(who, from, to, pages, key);
					const unchanged = Effect.gen(function* () {
						assert.deepEqual(yield* messages.get(initial.id), initial);
						assert.equal((yield* sql`SELECT path FROM topics WHERE path='new/project'`).length, 0);
						assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
					});
					if (mode === "symlink-source" || mode === "symlink-destination") {
						const location = mode === "symlink-source" ? "project" : "new/project";
						if (mode === "symlink-destination") yield* fs.makeDirectory(`${root}/pages/new`);
						yield* fs.symlink(`${root}/absent`, `${root}/pages/${location}`);
						yield* reject(move());
						yield* unchanged;
						assert.equal(yield* fs.readLink(`${root}/pages/${location}`), `${root}/absent`);
						assert.equal((yield* events.state).pending_id, null);
						assert.equal((yield* sql`SELECT seq FROM topic_page_continuations`).length, 0);
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["topic.moved"] })).items.length, 0);
						return;
					}
					if (mode === "read-snapshot") {
						const before = yield* events.state;
						yield* messages
							.read((fence) =>
								Effect.gen(function* () {
									assert.equal(fence, before.published_through);
									assert.deepEqual(yield* messages.get(initial.id), initial);
									assert.deepEqual(
										(yield* messages.list({ since: 0, topic: "project", recursive: true, limit: 20 })).items,
										[initial],
									);
									yield* messages.read((inner) => Effect.sync(() => assert.equal(inner, fence)));
									yield* reject(messages.create(who, { topic: "bad", body: "must not deadlock" }), "input_invalid");
								}),
							)
							.pipe(Effect.timeout("2 seconds"));
						assert.deepEqual(yield* events.state, before);
						assert.equal((yield* sql`SELECT path FROM topics WHERE path='bad'`).length, 0);
						return;
					}
					if (mode === "health") {
						const before = yield* events.state;
						let touched = false;
						const forbiddenPages = {
							prepare: () =>
								Effect.sync(() => {
									touched = true;
									return false;
								}),
							finish: () =>
								Effect.sync(() => {
									touched = true;
									return undefined;
								}),
						};
						yield* reject(
							messages.moveTopic(who, "project", "new/project", forbiddenPages).pipe(Effect.provide(healthLayer)),
							"input_invalid",
						);
						assert.equal(touched, false);
						assert.deepEqual(yield* events.state, before);
						yield* unchanged;
						return;
					}
					if (mode === "reserved-event") {
						yield* Ref.set((yield* Lifecycle).state, "live");
						const data = yield* extensionData;
						const before = yield* events.state;
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
						return;
					}
					if (mode === "validation") {
						for (const [from, to] of [
							["project", "project"],
							["project", "project/descendant"],
							["project/child", "project"],
							["project", "../bad"],
							["missing", "new/project"],
							["project", "project-other"],
							["project", "x".repeat(198)],
						] as const)
							yield* reject(move(from, to));
						yield* reject(move("project", "new/project", ""), "input_invalid");
						for (const status of ["archived", "deleted"] as const) {
							yield* messages.topic(who, status, { meta: {} });
							if (status === "archived") yield* messages.topic(who, status, { archived: true });
							else yield* deleteTopic(who, status);
							yield* reject(move("project", `${status}/new`));
							yield* reject(move(status, "unused"));
						}
						yield* fs.makeDirectory(`${root}/pages/collision`);
						yield* reject(move("project", "collision"), "topic_exists");
						yield* unchanged;
						yield* fs.makeDirectory(`${root}/pages/page-only`);
						yield* fs.writeFileString(`${root}/pages/page-only/index.md`, "only pages");
						assert.equal((yield* move("page-only", "page-moved")).to, "page-moved");
						assert.equal(yield* fs.readFileString(`${root}/pages/page-moved/index.md`), "only pages");
						return;
					}
					if (mode === "ancestors") {
						const remaining = yield* messages.create(who, { topic: "project/remaining", body: "stay here" });
						yield* move("project/child", "new/child");
						assert.deepEqual(
							yield* sql`SELECT path,last_seq FROM topics WHERE path IN ('project','new','new/child') ORDER BY path`,
							[
								{ path: "new", last_seq: initial.seq },
								{ path: "new/child", last_seq: initial.seq },
								{ path: "project", last_seq: remaining.seq },
							],
						);
						return;
					}
					if (mode === "stale") {
						const beforeTopics = yield* sql`SELECT * FROM topics ORDER BY path`;
						const beforeMessages = yield* sql`SELECT * FROM messages ORDER BY seq`;
						const beforeReads = yield* sql`SELECT * FROM reads ORDER BY instance,topic`;
						yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
						const before = yield* events.state;
						yield* reject(move(), "stale_writer");
						assert.deepEqual(yield* events.state, before);
						assert.deepEqual(yield* sql`SELECT * FROM topics ORDER BY path`, beforeTopics);
						assert.deepEqual(yield* sql`SELECT * FROM messages ORDER BY seq`, beforeMessages);
						assert.deepEqual(yield* sql`SELECT * FROM reads ORDER BY instance,topic`, beforeReads);
						assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
						yield* reject(messages.get(initial.id), "stale_writer");
						yield* reject(messages.list({ since: 0, limit: 20 }), "stale_writer");
						return;
					}
					if (mode === "rename-rollback" || mode === "rename-restart" || mode === "keyless-restart") {
						yield* fs.makeDirectory(`${root}/pages/project`);
						yield* fs.writeFileString(`${root}/pages/project/index.md`, "original");
						yield* sql`CREATE TRIGGER reject_completion BEFORE UPDATE OF completed ON topic_page_continuations BEGIN SELECT RAISE(ABORT,'reject'); END`;
						yield* reject(
							messages.moveTopic(who, "project", "new/project", pages, mode === "keyless-restart" ? undefined : "move"),
						);
						assert.equal(yield* fs.exists(`${root}/pages/project`), false);
						assert.equal(yield* fs.readFileString(`${root}/pages/new/project/index.md`), "original");
						assert.deepEqual(yield* sql`SELECT completed FROM topic_page_continuations`, [{ completed: 0 }]);
						for (const topic of ["project", "project/child", "new", "new/project/child"])
							assert.equal((yield* pendingPageMove(sql, topic)).length, 1);
						assert.equal((yield* pendingPageMove(sql, "project-other")).length, 0);
						yield* reject(move("new/project", "elsewhere", "overlap"), "topic_move_pending");
						const reused = yield* messages.create(who, { topic: "project/child", body: "new source" });
						yield* fs.makeDirectory(`${root}/pages/project`);
						yield* fs.writeFileString(`${root}/pages/project/index.md`, "replacement");
						if (phase === "prepare") return;
						yield* sql`DROP TRIGGER reject_completion`;
						const result = yield* move();
						assert.deepEqual(yield* move(), result);
						assert.equal((yield* pendingPageMove(sql, "project")).length, 0);
						assert.equal(yield* fs.readFileString(`${root}/pages/project/index.md`), "replacement");
						assert.equal(yield* fs.readFileString(`${root}/pages/new/project/index.md`), "original");
						assert.deepEqual(yield* messages.get(reused.id), reused);
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["topic.moved"] })).items.length, 1);
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["topic.pages_moved"] })).items.length, 1);
						return;
					}
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER reject_move BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='topic.moved' BEGIN SELECT RAISE(ABORT,'reject'); END`;
					testing = true;
					if (mode === "sql-failure" || mode === "reserve-lost") {
						yield* reject(move());
						yield* unchanged;
						assert.equal((yield* events.state).pending_id, null);
						if (mode === "sql-failure") yield* sql`DROP TRIGGER reject_move`;
						assert.equal((yield* move()).to, "new/project");
						return;
					}
					if (mode === "append-lost" || mode === "append-unavailable") {
						const before = yield* events.state;
						yield* reject(move(), "boot_unavailable");
						assert.equal((yield* sql`SELECT seq FROM outbox`).length, 1);
						if (mode === "append-unavailable") {
							assert.equal((yield* events.state).published_through, before.published_through);
							yield* reject(messages.get(initial.id), "boot_unavailable");
						}
						testing = false;
						assert.equal((yield* messages.get(initial.id)).topic, "new/project/child");
						assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
						const result = yield* move();
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["topic.moved"] })).items.length, 1);
						assert.equal(result.seq, (yield* events.state).published_through);
						return;
					}
					const deleted = yield* messages.create(who, { topic: "project/deleted", body: "preserve tombstone" });
					yield* deleteTopic(who, "project/deleted");
					yield* sql`INSERT INTO reads VALUES('family','new/project/child',${sibling.seq})`;
					const receipts = yield* sql`SELECT * FROM idempotency ORDER BY key`;
					const reactions = yield* sql`SELECT * FROM reactions`;
					const result = yield* move();
					assert.deepEqual(yield* move(), result);
					yield* reject(move("project", "elsewhere"), "idempotency_conflict");
					assert.deepEqual(yield* sql`SELECT * FROM idempotency WHERE kind<>'topic.moved' ORDER BY key`, receipts);
					assert.deepEqual(yield* sql`SELECT * FROM reactions`, reactions);
					assert.equal((yield* messages.get(initial.id)).topic, "new/project/child");
					assert.deepEqual(yield* messages.get(sibling.id), sibling);
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
					assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
					// A migrated legacy receipt has no page continuation and must never consume a recreated source.
					yield* sql`UPDATE idempotency SET key=${JSON.stringify(["legacy", "topic", "move"])} WHERE kind='topic.moved'`;
					assert.equal((yield* sql`SELECT seq FROM topic_page_continuations`).length, 0);
					const reused = yield* messages.create(who, { topic: "project/child", body: "new content at original path" });
					yield* fs.makeDirectory(`${root}/pages/project`);
					yield* fs.writeFileString(`${root}/pages/project/index.md`, "later page");
					assert.deepEqual(yield* move(), result);
					assert.deepEqual(yield* messages.get(reused.id), reused);
					assert.equal(yield* fs.readFileString(`${root}/pages/project/index.md`), "later page");
				}).pipe(
					Effect.provide(Layer.mergeAll(messagesLayer.pipe(Layer.provideMerge(publicationLayer)), lifecycleLayer)),
				);
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
	yield* Console.log("MOVE_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
