import { BunRuntime, BunServices } from "@effect/platform-bun";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import { connectionOf, parseDescriptor } from "@comms/storage/store";
import { Console, Effect, Schema, Stdio, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ErrorEnvelope } from "@comms/protocol/errors";
import { BootChannel } from "../../src/kernel/boot-channel.ts";
import { makeSqlReader } from "../../src/kernel/sql-read.ts";
import { ReadRequest, ReadResponse } from "../../src/kernel/sql-read-wire.ts";
import { refusal } from "../../src/conversation-request.ts";

const main = Effect.gen(function* () {
	const request = yield* (yield* Stdio.Stdio).stdin.pipe(
		Stream.decodeText(),
		Stream.runCollect,
		Effect.map((parts) => parts.join("")),
		Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReadRequest))),
	);
	const store = yield* parseDescriptor(request.store);
	if (store._tag === "file" || store.database !== "comms_schema_query")
		return yield* Effect.die("Disposable remote reader store required");
	const unavailable = () => Effect.die("Unexpected boot capability");
	const channel: BootChannel["Service"] = {
		store,
		filename: null,
		epoch: "reader-test",
		generation: 1,
		backup: Effect.void,
		changed: unavailable,
		fence: unavailable(),
		events: unavailable,
		reserve: unavailable,
		abort: unavailable,
		append: unavailable,
	};
	return yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`SELECT 1`;
		// This writing session holds the real lock throughout makeSqlReader and its subprocess.
		const read = yield* makeSqlReader;
		return yield* read(request.input, request.allowRead).pipe(
			refusal,
			Effect.catchIf(Schema.is(ErrorEnvelope), Effect.succeed),
		);
	}).pipe(
		Effect.provide(advisoryClientLayer({ connection: yield* connectionOf(store, false) })),
		Effect.provideService(BootChannel, channel),
	);
}).pipe(
	Effect.scoped,
	Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
	Effect.flatMap(Schema.decodeUnknownEffect(ReadResponse)),
	Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ReadResponse))),
	Effect.flatMap(Console.log),
	Effect.provide(BunServices.layer),
);
main.pipe(BunRuntime.runMain);
