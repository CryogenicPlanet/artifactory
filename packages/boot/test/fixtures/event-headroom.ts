import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import type { Destination } from "../../src/traffic.ts";
import { eventRoute, type Attempt } from "../../src/event-http.ts";
import { Batch, Events, layer } from "../../src/events.ts";
import { EventStorageRejected } from "../../src/event-storage.ts";
import { requireHeadroom, StorageRejected } from "../../src/storage-headroom.ts";

Effect.gen(function* () {
	const available = yield* Ref.make(100);
	const budgetError = yield* Ref.make<EventStorageRejected | null>(null);
	const admission = Ref.get(available).pipe(
		Effect.flatMap((available_bytes) =>
			requireHeadroom({ status: "available", capacity_bytes: 1000, available_bytes }),
		),
		Effect.andThen(Ref.get(budgetError).pipe(Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void)))),
	);
	yield* initializeBootSchema;
	yield* Effect.gen(function* () {
		const events = yield* Events;
		const sql = yield* SqlClient.SqlClient;
		const pending = yield* events.reserve("publish", 1, "epoch");
		yield* Ref.set(available, 49);
		const before = yield* events.state;
		assert.deepEqual(yield* events.reserve("publish", 1, "epoch"), pending);
		const conflict = yield* events.reserve("publish", 2, "epoch").pipe(Effect.result);
		assert.equal(conflict._tag, "Failure");
		const event = {
			at: 0,
			type: "message.created",
			level: "info" as const,
			actor: "boot",
			instance: null,
			generation: 1,
			request_id: null,
			topic: null,
			message_id: null,
			payload: {},
		};
		yield* events.writeBoot({ ...event, type: "generation.live" });
		yield* events.append({ ...pending, events: [{ ...event, seq: pending.from }] }, "epoch");
		assert.equal((yield* events.state).published_through, before.next);
		const cleared = yield* events.state;
		const rejected = yield* events.reserve("refused", 1, "epoch").pipe(Effect.result);
		assert.equal(rejected._tag, "Failure");
		if (rejected._tag === "Failure") {
			assert.ok(Schema.is(StorageRejected)(rejected.failure));
			assert.equal(rejected.failure.code, "storage_headroom");
		}
		assert.deepEqual(yield* events.state, cleared);
		assert.deepEqual(yield* sql`SELECT id FROM event_batches WHERE id='refused'`, []);
		const attempts = yield* Ref.make<readonly Attempt[]>([
			{ secret: "test", epoch: "epoch", host: "localhost", generation: 1, state: "live" },
		]);
		const gate = yield* Semaphore.make(1);
		const route = yield* Ref.make<Destination | null>(null);
		const response = yield* eventRoute(events, attempts, null, gate, route).pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(
					new Request("http://localhost/_boot/seq/reserve", {
						method: "POST",
						headers: { host: "localhost", "x-boot-secret": "test" },
						body: '{"transaction":"http-refused","count":1}',
					}),
				),
			),
		);
		assert.equal(response?.status, 507);
		assert.equal(response?.body._tag, "Uint8Array");
		if (response?.body._tag === "Uint8Array") {
			const body = yield* Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						error: Schema.Struct({ code: Schema.String, retriable: Schema.Boolean, hint: Schema.String }),
					}),
				),
			)(new TextDecoder().decode(response.body.body));
			assert.equal(body.error.code, "storage_headroom");
			assert.equal(body.error.retriable, false);
			assert.match(body.error.hint, /Free space/);
		}
		assert.deepEqual(yield* events.state, cleared);
		yield* Ref.set(available, 50);
		yield* events.reserve("abort", 1, "epoch");
		yield* Ref.set(available, 0);
		yield* events.abort("abort", "epoch");
		yield* events.writeBoot({ ...event, type: "storage.warning" });
		assert.equal((yield* events.state).pending_id, null);
		assert.equal((yield* events.state).published_through, 6);

		const send = (pathname: string, body: string, secret = "test") =>
			eventRoute(events, attempts, null, gate, route).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(
						new Request(`http://localhost${pathname}`, {
							method: "POST",
							headers: { host: "localhost", "x-boot-secret": secret },
							body,
						}),
					),
				),
			);
		yield* Ref.update(attempts, (current) => current.map((attempt) => ({ ...attempt, state: "starting" })));
		assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"probe","count":1}', "wrong"))?.status, 403);
		assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"probe","count":1}'))?.status, 200);
		assert.equal((yield* events.state).pending_id, "probe");
		assert.equal((yield* send("/_boot/events/append", "{}"))?.status, 409);
		assert.equal((yield* send("/_boot/seq/abort", '{"transaction":"probe"}'))?.status, 204);
		assert.equal((yield* events.state).pending_id, null);
		for (const state of ["live", "frozen"] as const) {
			yield* Ref.update(attempts, (current) => current.map((attempt) => ({ ...attempt, state })));
			assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"new-write","count":1}'))?.status, 507);
		}
		assert.equal((yield* events.state).next, 9);
		yield* Ref.update(attempts, (current) => current.map((attempt) => ({ ...attempt, state: "accepted" })));
		assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"too-many","count":2}'))?.status, 507);
		// Finalized batches are acknowledgements, even when their original event was not a policy snapshot.
		const encodeBatch = Schema.encodeEffect(Schema.fromJsonString(Batch));
		assert.equal(
			(yield* send(
				"/_boot/events/append",
				yield* encodeBatch({ ...pending, events: [{ ...event, seq: pending.from }] }),
			))?.status,
			200,
		);
		assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"completion","count":1}'))?.status, 200);
		const completionSeq = (yield* events.state).pending_from;
		assert.ok(completionSeq !== null);
		const completion = { transaction: "completion", from: completionSeq, to: completionSeq };
		assert.equal(
			(yield* send(
				"/_boot/events/append",
				yield* encodeBatch({ ...completion, events: [{ ...event, seq: completionSeq }] }),
			))?.status,
			409,
		);
		assert.equal((yield* events.state).pending_id, "completion");
		assert.equal(
			(yield* send(
				"/_boot/events/append",
				yield* encodeBatch({
					...completion,
					events: [{ ...event, seq: completionSeq, type: "pages.public", payload: { paths: ["saved"] } }],
				}),
			))?.status,
			200,
		);
		assert.deepEqual(yield* sql`SELECT path FROM public_paths`, [{ path: "saved" }]);
		const accepted = (yield* Ref.get(attempts))[0];
		assert.ok(accepted);
		yield* Ref.set(route, { ...accepted, port: 1, pid: 1, snapshot: "saved" });
		assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"routed-accepted","count":1}'))?.status, 507);
		yield* Ref.update(attempts, (current) => current.map((attempt) => ({ ...attempt, state: "live" })));
		assert.equal((yield* send("/_boot/seq/reserve", '{"transaction":"routed-live","count":1}'))?.status, 507);

		yield* Ref.set(available, 100);
		for (const code of ["event_storage_unavailable", "event_storage_over_budget"] as const) {
			yield* Ref.set(budgetError, new EventStorageRejected({ code }));
			const denied = yield* send("/_boot/seq/reserve", '{"transaction":"budget-refusal","count":1}');
			assert.equal(denied?.status, code === "event_storage_unavailable" ? 503 : 507);
			assert.ok(denied?.body._tag === "Uint8Array");
			assert.match(new TextDecoder().decode(denied.body.body), new RegExp(code));
			yield* Ref.update(attempts, (current) => current.map((attempt) => ({ ...attempt, state: "starting" })));
			assert.equal((yield* send("/_boot/seq/reserve", JSON.stringify({ transaction: code, count: 1 })))?.status, 200);
			assert.equal((yield* send("/_boot/seq/abort", JSON.stringify({ transaction: code })))?.status, 204);
			yield* Ref.update(attempts, (current) => current.map((attempt) => ({ ...attempt, state: "live" })));
		}

		assert.deepEqual(
			yield* sql`SELECT json_extract(event,'$.payload.transaction') AS id,
			json_extract(event,'$.payload.purpose') AS purpose FROM events WHERE type='seq.reserved' ORDER BY seq`,
			[
				{ id: "publish", purpose: "mutation" },
				{ id: "abort", purpose: "mutation" },
				{ id: "probe", purpose: "startup" },
				{ id: "completion", purpose: "startup" },
				{ id: "event_storage_unavailable", purpose: "startup" },
				{ id: "event_storage_over_budget", purpose: "startup" },
			],
		);
		yield* Console.log("reservation headroom verified");
	}).pipe(Effect.provide(layer(admission)));
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), BunServices.layer)),
	BunRuntime.runMain,
);
