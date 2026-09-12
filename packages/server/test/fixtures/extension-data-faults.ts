import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Ref } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { extensionData } from "../../src/kernel/extension-data.ts";
import { Lifecycle, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
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
				epoch,
				filename: `${root}/comms.db`,
				generation: 2,
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
					const lifecycle = yield* Lifecycle;
					const data = yield* extensionData;
					const one = data("one.ts", { agent: "human", instance: "human-session", request: "req", kind: "human" });
					const two = data("two.ts");
					const sql = yield* SqlClient.SqlClient;
					yield* Ref.set(lifecycle.healthy, true);
					for (const state of ["starting", "rehearsal", "candidate", "accepted", "frozen", "draining"] as const) {
						yield* Ref.set(lifecycle.state, state);
						assert.equal((yield* one.kv().set("key", 1).pipe(Effect.result))._tag, "Failure");
						assert.equal((yield* one.log("example.done", {}).pipe(Effect.result))._tag, "Failure");
					}
					assert.equal((yield* sql`SELECT * FROM kv`).length, 0);
					assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
					yield* Ref.set(lifecycle.state, "live");
					assert.equal((yield* sql.withTransaction(one.kv().set("key", 0)).pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* sql.withTransaction(one.log("example.done", {})).pipe(Effect.result))._tag, "Failure");
					yield* one.kv().set("key", { saved: "old" });
					assert.equal(yield* two.kv().get("key"), null);
					assert.equal(yield* data("one.js").kv().get("key"), null);
					assert.equal((yield* two.kv("one.ts").get("key").pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* two.kv("one.ts").set("key", 2).pipe(Effect.result))._tag, "Failure");
					assert.equal(
						(yield* data("one.ts", undefined, false).kv().set("key", 2).pipe(Effect.result))._tag,
						"Failure",
					);
					testing = true;
					if (mode === "sql-failure")
						yield* sql`CREATE TRIGGER refuse_kv BEFORE INSERT ON outbox WHEN json_extract(NEW.event,'$.type')='kv.set' BEGIN SELECT RAISE(ABORT,'kv failure'); END`;
					assert.equal((yield* one.kv().set("key", { saved: "new" }).pipe(Effect.result))._tag, "Failure");
					assert.deepEqual(yield* one.kv().get("key"), { saved: mode === "append-lost" ? "new" : "old" });
					if (mode === "sql-failure") yield* sql`DROP TRIGGER refuse_kv`;
					yield* messages.relay;
					if (mode === "append-before" || mode === "append-lost")
						assert.deepEqual(yield* one.kv().get("key"), { saved: "new" });
					else assert.deepEqual(yield* one.kv().get("key"), { saved: "old" });
					yield* one.log("example.done", { value: 42, extension: "forged" });
					const event = (yield* events.query({ since: 0, limit: 100, types: ["example.done"] })).items[0];
					assert.equal(event?.actor, "human");
					assert.equal(event?.instance, "human-session");
					assert.deepEqual(event?.payload, { value: 42, extension: "one.ts" });
					yield* one.kv().delete("key");
					assert.equal(yield* one.kv().get("key"), null);
					yield* sql`UPDATE kernel_writer SET epoch='replaced'`;
					assert.equal((yield* one.kv().set("key", 3).pipe(Effect.result))._tag, "Failure");
					assert.equal((yield* one.log("example.done", {}).pipe(Effect.result))._tag, "Failure");
					const staleRead = yield* one.kv().get("key").pipe(Effect.result);
					assert.equal(staleRead._tag, "Failure");
					if (staleRead._tag === "Failure")
						assert.equal(staleRead.failure._tag === "KernelError" && staleRead.failure.code, "stale_writer");
					yield* Console.log("EXTENSION_DATA_RECOVERED");
				}).pipe(
					Effect.provide(Layer.mergeAll(messagesLayer.pipe(Layer.provideMerge(publicationLayer)), lifecycleLayer)),
				);
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
