import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/kernel/database.ts";
import { Messages, layer as messagesLayer } from "../../src/kernel/messages.ts";
import { markView } from "../../src/read-view.ts";
import { Lifecycle, type State } from "../../src/kernel/lifecycle.ts";
const program = Effect.gen(function* () {
	const [root, mode = "normal"] = process.argv.slice(2);
	if (!root) return yield* Effect.die("Missing root");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
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
				reserve: (transaction, count) => events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable)),
				append: (batch) => events.append(batch, epoch).pipe(Effect.mapError(unavailable)),
				abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			};
			return yield* Effect.gen(function* () {
				yield* initialize;
				return yield* Effect.gen(function* () {
					const messages = yield* Messages;
					const who = { agent: "rahul", instance: "session", request: "request", kind: "human" as const };
					const input = { topic: "fault/thread", body: "durable" };

					const initial = yield* messages.create(who, input);
					const sql = yield* SqlClient.SqlClient;
					const before = yield* events.state;
					const outbox = yield* sql`SELECT * FROM outbox`;
					const state = yield* Ref.make<State>("live");
					const lifecycle = Layer.mock(Lifecycle, {
						initial: "starting",
						drained: yield* Deferred.make<void>(),
						state,
						gate: yield* Semaphore.make(1),
						mutations: yield* Ref.make(0),
						requests: yield* Ref.make(0),
						healthy: yield* Ref.make(true),
					});
					const view = markView(who, [initial], input.topic).pipe(Effect.provide(lifecycle));
					if (mode === "frozen") {
						yield* Ref.set(state, "frozen");
						yield* view;
						assert.deepEqual(yield* sql`SELECT * FROM reads`, []);
						yield* Ref.set(state, "live");
					}
					yield* view;
					yield* view;
					assert.deepEqual(yield* sql`SELECT topic,seq FROM reads`, [{ topic: input.topic, seq: initial.seq }]);
					yield* messages.mark(who, { topic: input.topic, seq: 0 });
					assert.deepEqual(yield* sql`SELECT topic,seq FROM reads`, [{ topic: input.topic, seq: initial.seq }]);
					assert.deepEqual(yield* events.state, before);
					assert.deepEqual(yield* sql`SELECT * FROM outbox`, outbox);
					yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
					const rejected = yield* messages.mark(who, { topic: "other", seq: initial.seq }).pipe(Effect.result);
					assert.equal(rejected._tag, "Failure");
					if (rejected._tag === "Failure")
						assert.equal(Schema.is(KernelError)(rejected.failure) && rejected.failure.code, "stale_writer");
					assert.deepEqual(yield* sql`SELECT topic,seq FROM reads`, [{ topic: input.topic, seq: initial.seq }]);
					yield* Console.log("READ_RECOVERED");
				}).pipe(Effect.provide(messagesLayer));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
