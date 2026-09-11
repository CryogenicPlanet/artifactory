import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/kernel/database.ts";
import { Messages, layer as messagesLayer } from "../../src/kernel/messages.ts";
import { Topics, layer as topicsLayer } from "../../src/kernel/topics.ts";
import { layer as pagesLayer } from "../../src/kernel/pages.ts";
import standup from "../../src/ext/standup.ts";
import type { Api } from "../../src/kernel/extension-api.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
const program = Effect.gen(function* () {
	const [root, mode = "normal"] = process.argv.slice(2);
	if (!root) return yield* Effect.die("Missing root");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			let holdFence = false;
			let reserveCalls = 0;
			let testingMutation = false;
			let failedAppend = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });

			const channel: BootChannel["Service"] = {
				epoch,
				filename: `${root}/comms.db`,
				generation: 2,
				changed: (after) =>
					events.changed(after).pipe(Effect.mapError(() => new KernelError({ code: "boot_unavailable" }))),
				fence: events.state.pipe(
					Effect.tap(() =>
						holdFence
							? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
							: Effect.void,
					),
					Effect.map((state) => ({ published_through: state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						reserveCalls++;

						if (testingMutation && mode === "reserve-lost" && reserveCalls === 2) return yield* unavailable();
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						if (testingMutation && mode === "append-before" && !failedAppend) {
							failedAppend = true;
							return yield* unavailable();
						}
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (testingMutation && ["append-lost", "numeric-retry"].includes(mode) && !failedAppend) {
							failedAppend = true;
							return yield* unavailable();
						}

						return result;
					}),
				abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			};
			return yield* Effect.gen(function* () {
				yield* initialize;
				return yield* Effect.gen(function* () {
					const messages = yield* Messages;
					const who = { agent: "rahul", instance: "session", request: "request", kind: "human" as const };
					const input = { topic: "fault/thread", body: "durable" };

					const initial = yield* messages.create(who, input, "create-key");
					const sql = yield* SqlClient.SqlClient;
					const topics = yield* Topics;
					if (mode === "numeric-retry") {
						testingMutation = true;
						const edit = messages.update(who, String(initial.seq), { body: "changed" }, "alias-edit");
						assert.equal((yield* edit.pipe(Effect.result))._tag, "Failure");
						const edited = yield* edit;
						assert.equal(edited.id, initial.id);
						assert.deepEqual(yield* edit, edited);
						failedAppend = false;
						const remove = messages.remove(who, String(initial.seq), "alias-delete");
						assert.equal((yield* remove.pipe(Effect.result))._tag, "Failure");
						const deleted = yield* remove;
						assert.deepEqual(yield* remove, deleted);
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["message.edited"] })).items.length, 1);
						assert.equal((yield* events.query({ since: 0, limit: 100, types: ["message.deleted"] })).items.length, 1);
						return yield* Console.log("MESSAGE_RECOVERED");
					}
					if (mode === "admission") {
						const originalState = yield* events.state;
						const originalOutbox = yield* sql`SELECT * FROM outbox ORDER BY seq`;
						const originalReceipts = yield* sql`SELECT * FROM idempotency ORDER BY key`;
						const oversized = { text: "é".repeat(70000) };
						for (const attempt of [
							messages.create(who, { ...input, meta: oversized }, "size-key"),
							messages.update(who, initial.id, { meta: oversized }, "size-key"),
						]) {
							const result = yield* attempt.pipe(Effect.result);
							assert.equal(result._tag, "Failure");
							if (result._tag === "Failure")
								assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, "input_invalid");
						}
						assert.equal(reserveCalls, 1);
						assert.deepEqual(yield* events.state, originalState);
						assert.deepEqual(yield* sql`SELECT * FROM outbox ORDER BY seq`, originalOutbox);
						assert.deepEqual(yield* sql`SELECT * FROM idempotency ORDER BY key`, originalReceipts);
						assert.deepEqual(yield* messages.get(initial.id), initial);
						const changed = yield* messages.update(who, initial.id, { meta: { text: "x".repeat(80000) } }, "size-key");
						const beforeMerged = yield* events.state;
						const merged = yield* messages.update(who, initial.id, { body: "x".repeat(60000) }).pipe(Effect.result);
						assert.equal(merged._tag, "Failure");
						assert.deepEqual(yield* events.state, beforeMerged);
						assert.deepEqual(yield* messages.get(initial.id), changed);
						const ceiling = beforeMerged.published_through;
						for (const attempt of [messages.list({ since: ceiling + 1, limit: 10 })]) {
							const result = yield* attempt.pipe(Effect.result);
							assert.equal(result._tag, "Failure");
							if (result._tag === "Failure")
								assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, "cursor_ahead");
						}
						assert.equal((yield* messages.list({ since: ceiling, limit: 10 })).cursor, ceiling);
						// Older versions admitted this aggregate size through individually bounded PATCH requests.
						yield* sql`UPDATE messages SET body=${"x".repeat(60000)} WHERE id=${initial.id}`;
						assert.equal(typeof (yield* messages.remove(who, initial.id)).deleted_at, "number");
						yield* messages.create(who, { ...input, body: "still writable" });
						return yield* Console.log("MESSAGE_RECOVERED");
					}
					const registrations: Array<Parameters<Api["route"]>[2]> = [];
					standup({
						context: () => Effect.die("not used"),
						mount: () => {},
						migrate: () => Effect.die("not used"),
						route: (_method, _path, options) => {
							registrations.push(options);
						},
						on: () => {},
						cron: () => {},
						page: () => {},
					});
					const handler = registrations[0]?.handler;
					if (!handler) return yield* Effect.die("Missing standup handler");
					const request = HttpServerRequest.fromWeb(new Request("http://localhost/api/standup"));
					const counts = Effect.gen(function* () {
						// Deliberately stale numeric ceiling: standup must capture its own fresh fence inside SQL.
						const work = handler(request, {
							...who,
							log: () => Effect.die("Standup must remain read-only"),
							kv: () => ({
								get: () => Effect.die("Standup must use message reads"),
								set: () => Effect.die("Standup must remain read-only"),
								delete: () => Effect.die("Standup must remain read-only"),
							}),
							db: sql,
							messages: { query: messages.list, create: () => Effect.die("read only") },
							topics: {
								read: (path, options) => topics.detail(who, path, options?.depth, options?.archived),
								meta: () => Effect.die("read only"),
							},
							emit: () => Effect.die("read only"),
							events: { query: channel.events, changed: channel.changed },
							mutate: () => Effect.die("Standup remains read only"),
							read: (task) =>
								sql.withTransaction(
									Effect.gen(function* () {
										yield* sql`SELECT epoch FROM kernel_writer`;
										return yield* task((yield* messages.fence).published_through);
									}),
								),
							publicationFence: messages.fence,
							params: {},
							query: {},
						});
						// An unexpected standup failure must fail this test instead of extending production error codes.
						// oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
						const response = yield* (Effect.isEffect(work) ? work : Effect.tryPromise(() => work)).pipe(Effect.orDie);
						return yield* Effect.tryPromise(() => response.json()).pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ agent: Schema.String, messages: Schema.Int }))),
							),
						);
					}).pipe(
						Effect.provideService(HttpServerRequest.HttpServerRequest, request),
						Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
						Effect.provideService(HttpRouter.RouteContext, {
							params: {},
							route: HttpRouter.route("GET", "/api/standup", HttpServerResponse.empty()),
						}),
					);
					assert.deepEqual(yield* counts, [{ agent: "rahul", messages: 1 }]);
					if (mode === "read-race") {
						holdFence = true;
						const readFiber = yield* messages.get(initial.id).pipe(Effect.forkChild);
						yield* Deferred.await(entered);
						const writeFiber = yield* messages
							.update(who, initial.id, { body: "one" })
							.pipe(Effect.andThen(messages.update(who, initial.id, { body: "two" })), Effect.forkChild);
						yield* Effect.sleep("30 millis");
						holdFence = false;
						yield* Deferred.succeed(release, undefined);
						assert.equal((yield* Fiber.join(readFiber)).body, "durable");
						yield* Fiber.join(writeFiber);
						assert.equal((yield* messages.get(initial.id)).body, "two");
						return yield* Console.log("MESSAGE_RECOVERED");
					}
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER reject_edit BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='message.edited' BEGIN SELECT RAISE(ABORT,'rejected edit'); END`;
					testingMutation = true;
					const first = yield* messages.update(who, initial.id, { body: "changed" }, "edit-key").pipe(Effect.result);
					assert.equal(first._tag, "Failure");
					if (mode === "sql-failure") yield* sql`DROP TRIGGER reject_edit`;
					const read = yield* messages.get(initial.id);
					assert.equal(read.body, mode === "append-lost" ? "changed" : "durable");
					assert.equal((yield* topics.detail(who, input.topic)).messages[0]?.body, read.body);
					assert.equal((yield* messages.list({ since: 0, limit: 100 })).items[0]?.body, read.body);
					const retry = yield* messages.update(who, initial.id, { body: "changed" }, "edit-key");
					assert.equal(retry.seq, initial.seq);
					assert.equal((yield* messages.get(initial.id)).body, "changed");
					assert.deepEqual(yield* messages.create(who, input, "create-key"), initial);
					assert.equal((yield* events.query({ since: 0, limit: 100, types: ["message.edited"] })).items.length, 1);
					// A failed delete must retain the previous published message until its event resolves.
					failedAppend = false;
					if (["append-before", "append-lost"].includes(mode)) {
						const deleted = yield* messages.remove(who, initial.id, "delete-key").pipe(Effect.result);
						assert.equal(deleted._tag, "Failure");
						assert.deepEqual(yield* counts, mode === "append-before" ? [{ agent: "rahul", messages: 1 }] : []);
						assert.equal(
							(yield* messages.list({ since: 0, limit: 100 })).items.length,
							mode === "append-before" ? 1 : 0,
						);
					}
					const removed = yield* messages.remove(who, initial.id, "delete-key");
					assert.equal(typeof removed.deleted_at, "number");
					assert.equal((yield* messages.list({ since: 0, limit: 100 })).items.length, 0);
					assert.equal((yield* topics.detail(who, input.topic)).unread, 0);
					assert.deepEqual(yield* counts, []);
					assert.equal((yield* events.query({ since: 0, limit: 100, types: ["message.deleted"] })).items.length, 1);
					assert.equal((yield* sql`SELECT seq FROM outbox WHERE shipped_at IS NULL`).length, 0);
					yield* Console.log("MESSAGE_RECOVERED");
				}).pipe(
					Effect.provide(
						topicsLayer.pipe(Layer.provide(pagesLayer(`${root}/pages`)), Layer.provideMerge(messagesLayer)),
					),
				);
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
