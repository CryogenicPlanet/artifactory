import { extensionCapabilities } from "../../src/ext/core/capabilities.ts";
import { layer as topicsLayer } from "../../src/ext/core/topics.ts";
import { layer as pagesLayer } from "../../src/ext/core/pages.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { SqlClient } from "effect/unstable/sql";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { markView } from "../../src/ext/core/read-view.ts";
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
					const view = Effect.gen(function* () {
						const ctx = (yield* extensionCapabilities)("read-mark-fixture", who, false);
						yield* markView(ctx, [initial], input.topic);
					}).pipe(
						Effect.provide(lifecycle),
						Effect.provide(topicsLayer.pipe(Layer.provideMerge(pagesLayer(`${root}/pages`)))),
					);
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
				}).pipe(Effect.provide(messagesLayer.pipe(Layer.provideMerge(publicationLayer))));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
