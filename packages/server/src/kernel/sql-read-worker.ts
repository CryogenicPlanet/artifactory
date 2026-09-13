import { connectionOf, parseDescriptor } from "@comms/storage/store";
import { remoteRead } from "./sql-read-remote.ts";
import { directClientLayer } from "@comms/storage/remote-client";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { Config, Console, Effect, Logger, Schema, Stdio, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ErrorEnvelope } from "@comms/protocol/errors";
import { refusal } from "../conversation-request.ts";
import { KernelError } from "./boot-channel.ts";
import { sqlInput, sqlQueryFailure } from "./sql-input.ts";
import { sqlRows } from "./sql-result.ts";
import { ReadRequest, ReadResponse } from "./sql-read-wire.ts";

const run = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const encoded = yield* stdio.stdin.pipe(
		Stream.decodeText(),
		Stream.runFoldEffect(
			() => "",
			(text, chunk) =>
				new TextEncoder().encode(text + chunk).byteLength > 70000
					? Effect.fail(new KernelError({ code: "input_invalid" }))
					: Effect.succeed(text + chunk),
		),
	);

	const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReadRequest))(encoded);
	yield* sqlInput(request.input);
	const store = yield* parseDescriptor(request.store);
	if (store._tag !== "file") {
		const tls = yield* Config.Boolean("DATABASE_TLS").pipe(Config.withDefault(false));
		return yield* remoteRead(request.input, request.allowRead, store._tag === "postgres" ? "pg" : "mysql").pipe(
			Effect.provide(directClientLayer({ connection: yield* connectionOf(store, tls) })),
		);
	}
	return yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const input = request.input;
				const wrapped = `SELECT * FROM (${input.sql}\n) AS q LIMIT 201`;
				let read = /^SELECT\b/i.test(input.sql.trim());
				if (!read && /^WITH\b/i.test(input.sql.trim())) {
					read = yield* sql.unsafe(`EXPLAIN ${wrapped}`, input.params ?? []).pipe(
						Effect.as(true),
						Effect.catchIf(
							(error) => Schema.is(Schema.Struct({ code: Schema.Literal("SQLITE_ERROR") }))(error.reason.cause),
							() => Effect.succeed(false),
						),
						Effect.mapError(sqlQueryFailure),
					);
				}
				if (!read) return { kind: "write" as const };
				if (!request.allowRead) return yield* new KernelError({ code: "scope_required" });
				const rows = yield* sql
					.unsafe<Record<string, unknown>>(wrapped, input.params ?? [])
					.pipe(Effect.provideService(SqlClient.SafeIntegers, true), Effect.mapError(sqlQueryFailure));
				return { kind: "read" as const, result: { ...(yield* sqlRows(rows)), dialect: "sqlite" as const } };
			}),
		);
	}).pipe(Effect.provide(clientLayer(store, { readonly: true, busyTimeout: "100 millis" })));
});
run.pipe(
	Effect.scoped,
	Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
	refusal,
	Effect.catchIf(Schema.is(ErrorEnvelope), Effect.succeed),
	Effect.flatMap(Schema.decodeUnknownEffect(ReadResponse)),
	Effect.flatMap((result) => Schema.encodeEffect(Schema.fromJsonString(ReadResponse))(result)),
	Effect.flatMap(Console.log),
	Effect.provide(BunServices.layer),
	Effect.provideService(Logger.LogToStderr, true),
	BunRuntime.runMain,
);
