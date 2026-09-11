import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { AppRecovery, layer as recoveryLayer } from "../../src/app-recovery.ts";
import { Events, layer as eventsLayer, EventRecord } from "../../src/events.ts";
import { layer as sourceLayer } from "../../src/source-files.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";
import { layer as pagesLayer } from "../../src/topic-page-move.ts";
import { moveRecovery } from "../../src/topic-move-recovery.ts";
import { legacyPageMovePreparation } from "./legacy-page-move-preparation.ts";

const Input = Schema.Struct({
	op: Schema.Literals(["seed", "recover"]),
	committed: Schema.optionalKey(Schema.Boolean),
	pause: Schema.optionalKey(Schema.Literals(["pages", "events"])),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const pause = Console.log("BOUNDARY").pipe(Effect.andThen(Effect.never));
	const hooks = {
		beforeAppend: (batch: Parameters<typeof moveRecovery.beforeAppend>[0]) =>
			moveRecovery.beforeAppend(batch).pipe(Effect.andThen(input.pause === "pages" ? pause : Effect.void)),
		afterResolve: input.pause === "events" ? pause : moveRecovery.afterResolve,
	};
	const services = Layer.mergeAll(
		eventsLayer(Effect.void),
		pagesLayer(root).pipe(Layer.provideMerge(sourceLayer(root).pipe(Layer.provide(lockLayer)))),
	);
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			const sql = yield* SqlClient.SqlClient;
			const recovery = yield* AppRecovery;
			if (input.op === "recover") {
				yield* recovery.prepare("replacement");
				return "recovered";
			}
			yield* recovery.prepare("original");
			yield* sql`INSERT INTO topic_moves(id,from_path,to_path,instance,request_key,request_hash,state) VALUES('move','old','new','human','retry','bound','prepared')`;
			yield* (yield* legacyPageMovePreparation(root))("move", "old", "new", "human");
			const range = yield* events.reserve("move", 1, "original");
			if (input.committed) {
				const event = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))({
					seq: range.from,
					at: 1,
					type: "topic.moved",
					level: "info",
					actor: "human",
					instance: "human",
					generation: 1,
					request_id: "move",
					topic: "new",
					message_id: null,
					payload: { from: "old", to: "new" },
				});
				yield* Effect.gen(function* () {
					const app = yield* SqlClient.SqlClient;
					yield* app.withTransaction(
						Effect.gen(function* () {
							yield* app`INSERT INTO mutation_batches VALUES('move',${range.from},${range.to},1)`;
							yield* app`INSERT INTO outbox VALUES(${range.from},'move',${event},NULL)`;
						}),
					);
				}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/comms.db`, disableWAL: true })), Effect.scoped);
			}
			return "seeded";
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`, hooks).pipe(Layer.provideMerge(services))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })), Effect.result);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
