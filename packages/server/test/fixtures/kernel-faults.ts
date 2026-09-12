import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Schema } from "effect";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
const program = Effect.gen(function* () {
	const [root, mode = "normal"] = process.argv.slice(2);
	if (!root) return yield* Effect.die("Missing root");
	const epoch = `epoch-${mode}`;
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			yield* (yield* AppRecovery).prepare(epoch);
			let reserveCalls = 0;
			const unavailable = () => new KernelError({ code: "boot_unavailable" });
			const pause = Console.log("PAUSED").pipe(Effect.andThen(Effect.never));
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
						reserveCalls++;
						if (mode === "beforecommit") return yield* pause;
						if (mode === "reserve-lost" && reserveCalls === 1) return yield* unavailable();
						return range;
					}),
				append: (batch) =>
					Effect.gen(function* () {
						if (mode === "aftercommit") return yield* pause;
						const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
						if (mode === "afterappend") return yield* pause;
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
					const first = yield* messages.create(who, input, "request-key").pipe(Effect.result);
					if (mode === "reserve-lost") {
						if (first._tag !== "Failure") return yield* Effect.die("Expected lost reserve result");
						yield* Console.log("ROLLBACK_CONFIRMED");
						const retry = yield* messages.create(who, input, "request-key");
						yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(retry));
					} else {
						if (first._tag === "Failure") return yield* first.failure;
						yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(first.success));
					}
				}).pipe(Effect.provide(messagesLayer.pipe(Layer.provideMerge(publicationLayer))));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
