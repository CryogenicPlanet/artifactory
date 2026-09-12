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
			let failedAppend = false;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });

			const channel: BootChannel["Service"] & { readonly filename: string } = {
				epoch,
				store: { _tag: "file", filename: `${root}/comms.db` },
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
						if (mode === "reserve-lost" && !failedReserve) {
							failedReserve = true;
							return yield* unavailable();
						}
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (mode === "append-lost" && !failedAppend) {
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
					const input = {
						transaction: "a".repeat(32),
						type: "ext.loaded" as const,
						level: "info" as const,
						payload: { extension: "example" },
					};
					const sql = yield* SqlClient.SqlClient;
					yield* Ref.set(lifecycle.healthy, true);
					for (const state of ["starting", "rehearsal", "candidate", "accepted", "frozen", "draining"] as const) {
						yield* Ref.set(lifecycle.state, state);
						const denied = yield* messages.recordEvent(input).pipe(Effect.result);
						assert.equal(denied._tag, "Failure");
						assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
					}
					yield* Ref.set(lifecycle.state, "live");
					const first = yield* messages.recordEvent(input).pipe(Effect.result);
					assert.equal(first._tag, "Failure");
					assert.equal((yield* sql`SELECT seq FROM outbox`).length, mode === "append-lost" ? 1 : 0);
					const retry = yield* messages.recordEvent(input);
					assert.equal(retry.type, "ext.loaded");
					assert.deepEqual(yield* messages.recordEvent(input), retry);
					const conflict = yield* messages
						.recordEvent({ ...input, payload: { extension: "different" } })
						.pipe(Effect.result);
					assert.equal(conflict._tag, "Failure");
					assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
					assert.equal((yield* sql`SELECT key FROM idempotency WHERE kind='ext.loaded'`).length, 1);
					const delivered = yield* events.query({ since: 0, limit: 100 });
					assert.deepEqual(
						delivered.items.filter((event) => event.type === "ext.loaded"),
						[retry],
					);
					assert.equal(
						delivered.items.filter((event) => event.type === "seq.reserved").length,
						mode === "reserve-lost" ? 2 : 1,
					);
					assert.equal(delivered.items.length, mode === "reserve-lost" ? 3 : 2);
					yield* sql`UPDATE kernel_writer SET epoch='replaced'`;
					const stale = yield* messages.recordEvent({ ...input, transaction: "b".repeat(32) }).pipe(Effect.result);
					assert.equal(stale._tag, "Failure");
					assert.deepEqual((yield* events.query({ since: 0, limit: 100 })).items, delivered.items);
					assert.equal((yield* sql`SELECT seq FROM outbox`).length, 0);
					yield* Console.log("OPERATIONAL_EVENT_RECOVERED");
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
