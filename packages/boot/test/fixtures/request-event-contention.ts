import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Deferred, Effect, Layer, Ref } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { Events, eventsSchema, layer } from "../../src/events.ts";
import { eventRoutingSchema } from "../../src/event-routing-schema.ts";
import { requestEvents } from "../../src/request-events.ts";
import { traffic } from "../../src/traffic.ts";

const main = Effect.gen(function* () {
	yield* eventsSchema;
	yield* eventRoutingSchema;
	return yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const events = yield* Events;
		const admission = yield* traffic;
		const held = yield* Ref.make(false);
		const release = yield* Deferred.make<void>();
		const attempts = yield* Ref.make(0);
		const written = yield* Ref.make(0);
		const store = yield* Ref.make<Events["Service"] | null>({
			...events,
			writeBoot: (event) =>
				Ref.update(attempts, (n) => n + 1).pipe(
					Effect.andThen(events.writeBoot(event)),
					Effect.tap(() => Ref.update(written, (n) => n + 1)),
				),
		});
		const observe = yield* requestEvents(store);
		const handler = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			if (request.url === "/hold") {
				yield* sql.withTransaction(Ref.set(held, true).pipe(Effect.andThen(Deferred.await(release))));
				return HttpServerResponse.empty();
			}
			if (request.url === "/fail") {
				yield* sql`CREATE TRIGGER reject_request_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'private-diagnostic-secret'); END`;
				return HttpServerResponse.empty();
			}
			if (request.url === "/repair") {
				yield* sql`DROP TRIGGER reject_request_event`;
				return HttpServerResponse.empty();
			}
			if (request.url === "/release") {
				yield* Deferred.succeed(release, undefined);
				return HttpServerResponse.empty();
			}
			if (request.url === "/stats")
				return HttpServerResponse.jsonUnsafe({
					held: yield* Ref.get(held),
					attempts: yield* Ref.get(attempts),
					written: yield* Ref.get(written),
					traffic: yield* admission.state,
				});
			yield* admission.admit;
			const observed = yield* observe({
				started: yield* Clock.monotonicTimeNanos,
				method: request.method,
				path: request.url,
				identity: null,
				generation: 1,
				requestId: "request-test",
			});
			yield* observed.status(200);
			return HttpServerResponse.text("response complete");
		});
		yield* HttpRouter.add("*", "/*", handler).pipe(
			(routes) => HttpRouter.serve(routes, { disableLogger: true }),
			Layer.build,
		);
		yield* Console.log(`Listening ${HttpServer.formatAddress((yield* HttpServer.HttpServer).address)}`);
		return yield* Effect.never;
	}).pipe(Effect.provide(layer));
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			BunServices.layer,
			SqliteClient.layer({ filename: ":memory:", disableWAL: true }),
			BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, gracefulShutdownTimeout: "1 second" }),
		),
	),
);
main.pipe(BunRuntime.runMain);
