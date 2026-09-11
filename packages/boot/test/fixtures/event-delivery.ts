import { layer as durableEventsLayer } from "../../src/events.ts";
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Crypto, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Events, EventRecord, layer } from "../../src/events.ts";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { authenticate } from "../../src/auth-http.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import type { Destination } from "../../src/traffic.ts";
import { eventRoute, type Attempt } from "../../src/event-http.ts";

const lockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const main = Effect.gen(function* () {
	yield* initializeBootSchema;
	return yield* Effect.gen(function* () {
		const events = yield* Events;
		const auth = yield* Auth;
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const reads = yield* Ref.make(0);
		const store: Events["Service"] = {
			...events,
			query: (input) => Ref.update(reads, (n) => n + 1).pipe(Effect.andThen(events.query(input))),
		};
		const server = yield* HttpServer.HttpServer;
		const host = new URL(HttpServer.formatAddress(server.address)).host;
		const attempts = yield* Ref.make<readonly Attempt[]>([
			{ secret: "fixture-secret", epoch: "fixture", host, generation: 1, state: "live" },
		]);
		const gate = yield* Semaphore.make(1);
		const route = yield* Ref.make<Destination | null>(null);
		const handler = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			if (request.url === "/token") {
				const token = Buffer.from(yield* crypto.randomBytes(32)).toString("base64url");
				const hash = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
				const now = yield* Clock.currentTimeMillis;
				yield* sql`INSERT INTO tokens VALUES ('token','pair','token-family','codex','access',${hash},'test','["read"]',${now + 60000},${now},NULL,NULL,NULL,NULL)`;
				return HttpServerResponse.jsonUnsafe({ token });
			}
			if (request.url === "/revoke") {
				yield* sql`UPDATE tokens SET revoked_at=${yield* Clock.currentTimeMillis}`;
				return HttpServerResponse.empty();
			}
			if (request.url === "/hold") {
				yield* gate.withPermit(Effect.sleep("3 seconds"));
				return HttpServerResponse.empty();
			}
			if (request.url === "/stats") return HttpServerResponse.jsonUnsafe({ reads: yield* Ref.get(reads) });
			if (request.url === "/retire") {
				yield* gate.withPermit(Ref.set(attempts, []));
				return HttpServerResponse.empty();
			}
			if (request.url === "/emit") {
				const event = yield* Schema.decodeUnknownEffect(EventRecord)(yield* request.json);
				yield* events.writeBoot(event);
				return HttpServerResponse.jsonUnsafe((yield* events.state).published_through);
			}
			return (
				(yield* eventRoute(
					store,
					attempts,
					request.headers["x-boot-secret"]
						? null
						: request.headers.authorization
							? yield* authenticate(auth, request)
							: {
									id: "caller-family",
									agent: "codex",
									kind: request.headers["x-test-human"] ? "human" : "agent",
									label: "test",
									scopes: request.headers["x-no-read"] ? [] : ["read"],
									expiresAt: (yield* Clock.currentTimeMillis) + (request.headers["x-short-expiry"] ? 300 : 60000),
								},
					gate,
					route,
					request.headers.authorization
						? authenticate(auth, request).pipe(
								Effect.as(true),
								Effect.orElseSucceed(() => false),
							)
						: Effect.succeed(true),
				)) ?? HttpServerResponse.empty({ status: 404 })
			);
		});
		yield* HttpRouter.add("*", "/*", handler).pipe(
			(routes) => HttpRouter.serve(routes, { disableLogger: true }),
			Layer.build,
		);
		yield* Console.log(`Listening http://${host}`);
		return yield* Effect.never;
	}).pipe(
		Effect.provide(
			authLayer({ rpId: "localhost", expectedOrigin: "http://localhost" }).pipe(
				Layer.provideMerge(Layer.mergeAll(layer(Effect.void), lockLayer)),
			),
		),
	);
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
