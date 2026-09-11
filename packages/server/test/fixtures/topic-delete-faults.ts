import { TopicDeleteError } from "../../../../examples/extensions/topic-delete.ts";
import { deleteTopic } from "./optional-topic-delete.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Schema } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { layer as topicsLayer } from "../../src/ext/core/topics.ts";
import { layer as pagesLayer } from "../../src/ext/core/pages.ts";

const program = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing arguments");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			let testing = false;
			let failed = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] = {
				epoch,
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
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "reserve-lost" && !failed) {
							failed = true;
							return yield* unavailable();
						}
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						if (testing && mode === "append-before" && !failed) {
							failed = true;
							return yield* unavailable();
						}
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "append-lost" && !failed) {
							failed = true;
							return yield* unavailable();
						}
						return result;
					}),
				abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			};
			yield* Effect.gen(function* () {
				yield* initialize;
				yield* Effect.gen(function* () {
					const messages = yield* Messages,
						sql = yield* SqlClient.SqlClient;
					const who = { agent: "codex", instance: "family", request: "request", kind: "agent" as const };
					const initial = yield* messages.create(who, { topic: "project/child", body: "retained" });
					yield* messages.topic(who, "project", { meta: { public: true, version: "original" } });
					const reject = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
						effect.pipe(
							Effect.result,
							Effect.map((result) => {
								assert.equal(result._tag, "Failure");
								if (result._tag === "Failure")
									assert.equal(
										(Schema.is(KernelError)(result.failure) || Schema.is(TopicDeleteError)(result.failure)) &&
											result.failure.code,
										code,
									);
							}),
						);
					if (mode === "authorization") {
						const before = yield* events.state;
						yield* reject(deleteTopic({ ...who, instance: "sibling" }, "project"), "author_required");
						assert.deepEqual(yield* events.state, before);
						const foreign = yield* messages.create(
							{ ...who, instance: "sibling" },
							{ topic: "project/child", body: "foreign" },
						);
						yield* messages.remove({ ...who, instance: "sibling" }, foreign.id);
						yield* reject(deleteTopic(who, "project"), "author_required");
						yield* messages.topic(who, "empty", { meta: {} }, "meta-key");
						yield* reject(deleteTopic(who, "empty", "meta-key"), "idempotency_conflict");
						yield* reject(deleteTopic(who, "empty"), "author_required");
						const human = { ...who, instance: "human", kind: "human" as const };
						yield* deleteTopic(human, "empty");
						const outcome = yield* deleteTopic(human, "project", "human-delete");
						assert.deepEqual(yield* deleteTopic(human, "project", "human-delete"), outcome);
						yield* reject(messages.topic(human, "project", { meta: {} }, "human-delete"), "idempotency_conflict");
						yield* reject(deleteTopic(human, "empty", "human-delete"), "idempotency_conflict");
						yield* reject(messages.topic(human, "project/new", { meta: {} }), "topic_not_found");
						yield* reject(messages.topic(human, "project/child", { archived: false }), "topic_not_found");
						return yield* Console.log("DELETE_RECOVERED");
					}
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER reject_topic BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='topic.deleted' BEGIN SELECT RAISE(ABORT,'reject'); END`;
					testing = true;
					assert.equal((yield* deleteTopic(who, "project", "delete").pipe(Effect.result))._tag, "Failure");
					const rows = yield* sql`SELECT deleted_at,previous,updated_seq FROM topics WHERE path='project'`.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({
										deleted_at: Schema.NullOr(Schema.Int),
										previous: Schema.fromJsonString(Schema.JsonObject),
										updated_seq: Schema.Int,
									}),
								),
							),
						),
					);
					if (mode === "append-before" || mode === "append-lost") {
						assert.equal(typeof rows[0]?.deleted_at, "number");
						assert.deepEqual(rows[0]?.previous, {
							meta: { public: true, version: "original" },
							archived_at: null,
							deleted_at: null,
						});
						assert.equal(
							(yield* events.state).published_through >= (rows[0]?.updated_seq ?? 0),
							mode === "append-lost",
						);
					} else assert.equal(rows[0]?.deleted_at, null);
					if (mode === "sql-failure") yield* sql`DROP TRIGGER reject_topic`;
					const deleted = yield* deleteTopic(who, "project", "delete");
					assert.deepEqual(yield* deleteTopic(who, "project", "delete"), deleted);
					assert.equal((yield* sql`SELECT id FROM messages WHERE id=${initial.id}`).length, 1);
					assert.equal((yield* sql`SELECT path FROM topics WHERE deleted_at IS NOT NULL`).length, 1);
					assert.equal((yield* events.query({ since: 0, limit: 100, types: ["topic.deleted"] })).items.length, 1);
					assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
					yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
					yield* reject(deleteTopic(who, "project", "delete"), "stale_writer");
					yield* Console.log("DELETE_RECOVERED");
				}).pipe(
					Effect.provide(
						topicsLayer.pipe(
							Layer.provide(pagesLayer(`${root}/pages`)),
							Layer.provideMerge(messagesLayer.pipe(Layer.provideMerge(publicationLayer))),
						),
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
