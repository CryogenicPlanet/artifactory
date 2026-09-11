// Test-only HTTP controls exercise the real writer gate on an orphan's open SQLite connection.
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Config, Console, Effect, Layer, Ref, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { EventRecord } from "@comms/protocol/events";
import { BootChannel, layer as channelLayer } from "../../src/kernel/boot-channel.ts";
import { writerGate } from "../../src/kernel/database.ts";
export const run = () =>
	Effect.gen(function* () {
		const filename = yield* Config.String("APP_DATABASE");
		const secret = yield* Config.String("BOOT_SECRET");
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient,
				boot = yield* BootChannel;
			const held = yield* Ref.make(false);
			const initialize = sql.withTransaction(
				Effect.gen(function* () {
					yield* writerGate(sql, boot.epoch);
					yield* sql`CREATE TABLE IF NOT EXISTS orphan_writes(id TEXT PRIMARY KEY)`;
				}),
			);
			const write = (hold: boolean) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* writerGate(sql, boot.epoch);
							if (hold) {
								const range = yield* boot.reserve("orphan-admitted", 1);
								const event = {
									seq: range.from,
									at: 1,
									type: "message.created",
									level: "info" as const,
									actor: "rahul",
									instance: "orphan",
									generation: boot.generation,
									request_id: "test",
									topic: "orphan",
									message_id: "orphan",
									payload: { body: "committed by admitted orphan" },
								};
								yield* sql`INSERT INTO mutation_batches VALUES('orphan-admitted',${range.from},${range.to},1)`;
								const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))(event);
								yield* sql`INSERT INTO outbox VALUES(${range.from},'orphan-admitted',${encoded},NULL)`;
								yield* Ref.set(held, true);
								yield* Effect.sleep("1200 millis");
							}
							yield* sql`INSERT INTO orphan_writes VALUES(${hold ? "admitted" : "late"})`;
							return HttpServerResponse.text("written");
						}),
					)
					.pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.text("fenced", { status: 409 }))));
			const http = yield* HttpServer.HttpServer;
			if (http.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP");
			yield* Layer.mergeAll(
				HttpRouter.add(
					"GET",
					"/health",
					HttpServerResponse.text("ok", {
						headers: { "x-comms-writer-epoch": boot.epoch, "x-comms-kernel-protocol": "2" },
					}),
				),
				HttpRouter.add(
					"GET",
					"/_kernel/ping",
					HttpServerResponse.empty({
						status: 200,
						headers: { "x-comms-writer-epoch": boot.epoch, "x-comms-kernel-protocol": "2" },
					}),
				),
				HttpRouter.add("POST", "/_kernel/control", initialize.pipe(Effect.as(HttpServerResponse.text("ok")))),
				HttpRouter.add("GET", "/channel", HttpServerResponse.jsonUnsafe({ secret })),
				HttpRouter.add("POST", "/admit", write(true)),
				HttpRouter.add("POST", "/write", write(false)),
				HttpRouter.add(
					"GET",
					"/held",
					Ref.get(held).pipe(Effect.map((value) => HttpServerResponse.jsonUnsafe({ held: value }))),
				),
			).pipe((routes) => HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }), Layer.build);
			yield* Console.log(`COMMS_CHILD_PORT=${http.address.port}`);
			return yield* Effect.never;
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					SqliteClient.layer({ filename, disableWAL: true }),
					channelLayer.pipe(Layer.provide(FetchHttpClient.layer)),
				),
			),
		);
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.mergeAll(
				BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, gracefulShutdownTimeout: "100 millis" }),
				BunServices.layer,
			),
		),
		BunRuntime.runMain,
	);
