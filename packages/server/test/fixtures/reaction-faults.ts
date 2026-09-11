import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/kernel/database.ts";
import { Messages, layer as messagesLayer } from "../../src/kernel/messages.ts";
const program = Effect.gen(function* () {
	const [root, mode = "normal"] = process.argv.slice(2);
	if (!root) return yield* Effect.die("Missing root");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			let failedReserve = false;
			let testing = false;
			let failedAppend = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });

			const channel: BootChannel["Service"] = {
				agents: Effect.succeed({ items: [] }),
				epoch,
				filename: `${root}/comms.db`,
				generation: 2,
				fence: events.state.pipe(
					Effect.map((state) => ({ published_through: state.published_through })),
					Effect.mapError(unavailable),
				),
				events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
				reserve: (transaction, count) =>
					Effect.gen(function* () {
						const range = yield* events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "reserve-lost" && !failedReserve) {
							failedReserve = true;
							return yield* unavailable();
						}
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						if (testing && mode === "append-before" && !failedAppend) {
							failedAppend = true;
							return yield* unavailable();
						}
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (testing && mode === "append-lost" && !failedAppend) {
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

					const sql = yield* SqlClient.SqlClient;
					const who = { agent: "codex", instance: "one", request: "request", kind: "agent" as const };
					const message = yield* messages.create(who, { topic: "project/thread", body: "Durable reactions" });
					const input = { message: message.id, emoji: "👍" };
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER refuse_reaction BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='reaction.added' BEGIN SELECT RAISE(ABORT,'reaction failure'); END`;
					testing = true;
					const failed = yield* messages.toggleReaction(who, input, "add").pipe(Effect.result);
					assert.equal(failed._tag, "Failure");
					assert.equal((yield* messages.reactions(message.id)).items.length, mode === "append-lost" ? 1 : 0);
					if (mode === "sql-failure") yield* sql`DROP TRIGGER refuse_reaction`;
					const retry = yield* messages.toggleReaction(who, input, "add");
					assert.equal(retry.active, true);
					assert.deepEqual(yield* messages.toggleReaction(who, input, "add"), retry);
					assert.equal((yield* messages.reactions(message.id)).items.length, 1);
					failedAppend = false;
					if (["append-before", "append-lost"].includes(mode)) {
						assert.equal((yield* messages.toggleReaction(who, input, "remove").pipe(Effect.result))._tag, "Failure");
						assert.equal((yield* messages.reactions(message.id)).items.length, mode === "append-before" ? 1 : 0);
					}
					const removed = yield* messages.toggleReaction(who, input, "remove");
					assert.equal(removed.active, false);
					assert.equal((yield* messages.reactions(message.id)).items.length, 0);
					assert.deepEqual(yield* messages.toggleReaction(who, input, "add"), retry);
					assert.equal((yield* messages.reactions(message.id)).items.length, 0);
					assert.equal(
						(yield* sql`SELECT seq FROM outbox WHERE json_extract(event,'$.type')='reaction.added'`).length,
						2,
					);
					assert.equal((yield* events.query({ since: message.seq, limit: 100 })).items.length, 2);
					yield* sql`UPDATE kernel_writer SET epoch='stale'`;
					assert.equal((yield* messages.toggleReaction(who, input, "stale").pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* messages.reactions(message.id)).items.length, 0);
					yield* Console.log("REACTIONS_RECOVERED");
				}).pipe(Effect.provide(messagesLayer));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
