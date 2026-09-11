import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { Events, layer as eventsLayer, Batch, EventRecord } from "../../src/events.ts";
import { AppRecovery, layer as recoveryLayer } from "../../src/app-recovery.ts";
const Input = Schema.Struct({
	op: Schema.Literals(["init", "reserve", "append", "abort", "boot", "query", "recover", "state"]),
	epoch: Schema.optionalKey(Schema.String),
	transaction: Schema.optionalKey(Schema.String),
	count: Schema.optionalKey(Schema.Int),
	batch: Schema.optionalKey(Batch),
	event: Schema.optionalKey(EventRecord),
	since: Schema.optionalKey(Schema.Int),
	limit: Schema.optionalKey(Schema.Int),
	topic: Schema.optionalKey(Schema.String),
	types: Schema.optionalKey(Schema.Array(Schema.String)),
	agent: Schema.optionalKey(Schema.String),
	instance: Schema.optionalKey(Schema.String),
	level: Schema.optionalKey(Schema.String),
	requestActor: Schema.optionalKey(Schema.String),
	excludeMessageInstance: Schema.optionalKey(Schema.String),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const argument = process.argv[3];
	const inputFile = process.argv[4];
	if (argument === "--input-file" && !inputFile) return yield* Effect.die("Missing input file");
	const json =
		argument === "--input-file" && inputFile
			? yield* (yield* FileSystem.FileSystem).readFileString(inputFile)
			: (argument ?? "{}");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(json);
	yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const result = yield* Effect.gen(function* () {
			const events = yield* Events;
			switch (input.op) {
				case "init":
					return "ok";
				case "state":
					return yield* events.state;
				case "reserve":
					return yield* events.reserve(input.transaction ?? "tx", input.count ?? 1, input.epoch ?? "attempt");
				case "abort":
					yield* events.abort(input.transaction ?? "tx", input.epoch ?? "attempt");
					return "ok";
				case "append":
					if (!input.batch) return yield* Effect.die("Missing batch");
					return yield* events.append(input.batch, input.epoch ?? "attempt");
				case "boot":
					if (!input.event) return yield* Effect.die("Missing event");
					yield* events.writeBoot(input.event);
					return "ok";
				case "query":
					return yield* events.query({
						...input,
						limit: input.limit ?? 100,
					});
				case "recover":
					yield* (yield* AppRecovery).prepare(input.epoch ?? "attempt");
					return "ok";
			}
		}).pipe(
			Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))),
			Effect.result,
		);
		yield* Console.log(
			yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
				result._tag === "Success"
					? { _tag: "Success", success: result.success }
					: { _tag: "Failure", failure: result.failure },
			),
		);
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
