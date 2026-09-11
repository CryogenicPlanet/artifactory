import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Ref } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/kernel/database.ts";
import { Messages, layer as messagesLayer } from "../../src/kernel/messages.ts";
import { Topics, layer as topicsLayer } from "../../src/kernel/topics.ts";
import { Lifecycle, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { layer as pagesLayer } from "../../src/kernel/pages.ts";

const program = Effect.gen(function* () {
	const [root, mode] = process.argv.slice(2);
	if (!root || !mode) return yield* Effect.die("Missing arguments");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			let holdAppend = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const channel: BootChannel["Service"] = {
				epoch,
				filename: `${root}/comms.db`,
				generation: 1,
				changed: (after) =>
					events.changed(after).pipe(Effect.mapError(() => new KernelError({ code: "boot_unavailable" }))),
				fence: events.state.pipe(
					Effect.map((state) => ({ published_through: state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) => events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable)),
				append: (batch) =>
					Effect.suspend(() =>
						holdAppend ? Effect.fail(unavailable()) : events.append(batch, epoch).pipe(Effect.mapError(unavailable)),
					),
				abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			};
			yield* Effect.gen(function* () {
				yield* initialize;
				yield* Effect.gen(function* () {
					const messages = yield* Messages,
						topics = yield* Topics,
						sql = yield* SqlClient.SqlClient;
					const fs = yield* FileSystem.FileSystem;
					yield* Ref.set((yield* Lifecycle).state, "live");
					const who = { agent: "codex", instance: "family", request: "request", kind: "agent" as const };
					const reader = { ...who, instance: "reader" };
					yield* fs.makeDirectory(`${root}/pages/project/page-only`, { recursive: true });
					yield* fs.writeFileString(`${root}/pages/project/page-only/index.md`, "retained page");
					const message = yield* messages.create(
						who,
						{ topic: "project/child", body: "retained needle @here" },
						"create",
					);
					const sibling = yield* messages.create(who, { topic: "project-other", body: "sibling needle @here" });
					yield* messages.mark(who, { topic: message.topic, seq: message.seq });
					const edit = yield* messages.update(who, message.id, { body: "edited needle @here" }, "edit");
					holdAppend = true;
					// Exercise a committed topic tombstone before boot publishes its event.
					assert.equal((yield* messages.deleteTopic(who, "project", "delete").pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* messages.get(message.id)).body, edit.body);
					assert.equal((yield* messages.list({ since: 0, limit: 100, q: "needle" })).items.length, 2);
					assert.equal(
						(yield* messages.list({ since: 0, limit: 100, mentions: ["@here"], exclude: reader.instance })).items
							.length,
						2,
					);
					assert.equal((yield* topics.detail(reader, "project", 2)).subtopics.length, 2);
					assert.equal((yield* topics.detail(reader, "project/page-only")).index, "retained page");
					holdAppend = false;
					yield* messages.relay;
					assert.equal((yield* messages.get(message.id).pipe(Effect.result))._tag, "Failure");
					assert.deepEqual(
						(yield* messages.list({ since: 0, limit: 100, q: "needle" })).items.map((item) => item.id),
						[sibling.id],
					);
					assert.deepEqual(
						(yield* messages.list({ since: 0, limit: 100, mentions: ["@here"], exclude: reader.instance })).items.map(
							(item) => item.id,
						),
						[sibling.id],
					);
					const board = yield* topics.detail(reader, "", 3, true);
					assert.deepEqual(
						board.subtopics.map((topic) => topic.path),
						["project-other"],
					);
					assert.equal(board.unread, 1);
					assert.deepEqual(
						board.messages.map((item) => item.id),
						[sibling.id],
					);
					for (const path of ["project", "project/child", "project/page-only"])
						assert.equal((yield* topics.detail(reader, path).pipe(Effect.result))._tag, "Failure");
					for (const action of [
						messages.create(who, { topic: "project/new/deep", body: "forbidden" }).pipe(Effect.asVoid),
						messages.update(who, message.id, { body: "forbidden" }).pipe(Effect.asVoid),
						messages.remove(who, message.id).pipe(Effect.asVoid),
					]) {
						const result = yield* action.pipe(Effect.result);
						assert.equal(result._tag, "Failure");
						if (result._tag === "Failure")
							assert.equal(result.failure._tag === "KernelError" && result.failure.code, "topic_not_found");
					}
					// Historical first outcomes remain replayable; they cannot recreate current rows.
					assert.deepEqual(
						yield* messages.create(who, { topic: message.topic, body: message.body }, "create"),
						message,
					);
					assert.deepEqual(yield* messages.update(who, message.id, { body: "edited needle @here" }, "edit"), edit);
					yield* messages.create(who, { topic: "project-other/child", body: "allowed" });
					assert.equal((yield* sql`SELECT id FROM messages`).length, 3);
					assert.equal(yield* fs.readFileString(`${root}/pages/project/page-only/index.md`), "retained page");
					yield* Console.log("TOPIC_VISIBILITY_VERIFIED");
				}).pipe(
					Effect.provide(
						Layer.merge(
							lifecycleLayer,
							topicsLayer.pipe(Layer.provide(pagesLayer(`${root}/pages`)), Layer.provideMerge(messagesLayer)),
						),
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
