import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, Fiber, Layer } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { Topics, layer as topicsLayer } from "../../src/ext/core/topics.ts";
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
			let holdFence = false;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] = {
				epoch,
				filename: `${root}/comms.db`,
				generation: 1,
				backup: Effect.void,
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
						topics = yield* Topics,
						sql = yield* SqlClient.SqlClient;
					const who = { agent: "codex", instance: "family", request: "request", kind: "agent" as const };
					yield* messages.create(who, { topic: "project/child", body: "retained" });
					yield* messages.topic(who, "project", { meta: { public: false, version: "original" } });
					if (mode === "read-race") {
						holdFence = true;
						const reader = yield* topics.detail(who, "project").pipe(Effect.forkChild);
						yield* Deferred.await(entered);
						const writer = yield* messages
							.topic(who, "project", { meta: { version: "one" } })
							.pipe(Effect.andThen(messages.topic(who, "project", { meta: { version: "two" } })), Effect.forkChild);
						yield* Effect.sleep("30 millis");
						holdFence = false;
						yield* Deferred.succeed(release, undefined);
						assert.equal((yield* Fiber.join(reader)).meta.version, "original");
						yield* Fiber.join(writer);
						assert.equal((yield* topics.detail(who, "project")).meta.version, "two");
						return yield* Console.log("TOPIC_RECOVERED");
					}
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER reject_topic BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='topic.meta' BEGIN SELECT RAISE(ABORT,'reject'); END`;
					testing = true;
					const input = { meta: { public: true, version: "updated" } };
					assert.equal((yield* messages.topic(who, "project", input, "update").pipe(Effect.result))._tag, "Failure");
					assert.equal(
						(yield* topics.detail(who, "project")).meta.version,
						mode === "append-lost" ? "updated" : "original",
					);
					if (mode === "sql-failure") yield* sql`DROP TRIGGER reject_topic`;
					const updated = yield* messages.topic(who, "project", input, "update");
					assert.equal((yield* topics.detail(who, "project")).meta.version, "updated");
					assert.deepEqual(yield* messages.topic(who, "project", input, "update"), updated);
					if (["append-before", "append-lost"].includes(mode)) {
						failed = false;
						assert.equal(
							(yield* messages.topic(who, "project", { archived: true }, "archive").pipe(Effect.result))._tag,
							"Failure",
						);
						const rootTopic = yield* topics.detail(who, "");
						assert.equal(rootTopic.subtopics.length, mode === "append-before" ? 1 : 0);
						assert.equal(rootTopic.unread, mode === "append-before" ? 1 : 0);
						assert.equal(rootTopic.messages.length, mode === "append-before" ? 1 : 0);
						yield* messages.topic(who, "project", { archived: true }, "archive");
						failed = false;
						assert.equal(
							(yield* messages.topic(who, "empty/child", { meta: { name: "new" } }, "create").pipe(Effect.result))._tag,
							"Failure",
						);
						assert.equal((yield* topics.detail(who, "")).subtopics.length, mode === "append-before" ? 0 : 1);
						yield* messages.topic(who, "empty/child", { meta: { name: "new" } }, "create");
						assert.equal((yield* topics.detail(who, "empty/child")).meta.name, "new");
					}
					assert.equal((yield* sql`SELECT seq FROM outbox WHERE shipped_at IS NULL`).length, 0);
					yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
					assert.equal((yield* messages.topic(who, "forbidden", { meta: {} }).pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* sql`SELECT path FROM topics WHERE path='forbidden'`).length, 0);
					yield* Console.log("TOPIC_RECOVERED");
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
