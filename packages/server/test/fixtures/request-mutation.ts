import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { AppRecovery, layer as recoveryLayer } from "../../../boot/src/app-recovery.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { extensionCapabilities } from "../../src/ext/core/capabilities.ts";
import { layer as pagesLayer } from "../../src/ext/core/pages.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { Lifecycle, RequestMutation, layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";

const program = Effect.gen(function* () {
	const [root] = process.argv.slice(2);
	if (!root) return yield* Effect.die("Missing root");
	const epoch = "request-mutation";
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
				changed: (after) => events.changed(after).pipe(Effect.mapError(unavailable)),
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
					const sql = yield* SqlClient.SqlClient;
					const lifecycle = yield* Lifecycle;
					const bind = yield* extensionCapabilities;
					const who = { agent: "rahul", instance: "session", request: "request", kind: "human" as const };
					const ctx = bind("request-fixture", who);
					const readOnly = bind("request-fixture", who, false);
					const background = bind("request-fixture");
					const active = yield* Ref.make(true);
					yield* Ref.set(lifecycle.healthy, true);
					// HTTP admission already owns this count for the entire request.
					yield* Ref.set(lifecycle.mutations, 1);
					yield* Ref.set(lifecycle.requests, 1);
					yield* sql`CREATE TABLE request_writes (state TEXT)`;
					const refused = <A, E, R>(operation: Effect.Effect<A, E, R>, code: string) =>
						Effect.gen(function* () {
							const result = yield* operation.pipe(Effect.result);
							assert.equal(result._tag, "Failure");
							if (result._tag === "Failure")
								assert.equal(Schema.is(KernelError)(result.failure) && result.failure.code, code);
						});
					yield* Effect.gen(function* () {
						for (const state of ["live", "frozen"] as const) {
							yield* Ref.set(lifecycle.state, state);
							yield* ctx.mutate(
								Effect.gen(function* () {
									assert.equal(yield* Ref.get(lifecycle.mutations), 2);
									yield* sql`INSERT INTO request_writes VALUES (${state})`;
								}),
							);
							yield* ctx.messages.create({ topic: "request/thread", body: state });
							assert.equal(yield* Ref.get(lifecycle.mutations), 1);
							assert.equal(yield* Ref.get(lifecycle.requests), 1);
						}
						const unwanted = sql`INSERT INTO request_writes VALUES ('unwanted')`;
						yield* refused(readOnly.mutate(unwanted), "scope_required");
						yield* refused(sql.withTransaction(ctx.mutate(unwanted)), "input_invalid");
						yield* Ref.set(active, false);
						yield* refused(ctx.mutate(unwanted), "generation_not_live");
						yield* refused(ctx.messages.create({ topic: "request/thread", body: "revoked" }), "generation_not_live");
					}).pipe(Effect.provideService(RequestMutation, active));
					yield* refused(
						background.mutate(sql`INSERT INTO request_writes VALUES ('background')`),
						"generation_not_live",
					);
					assert.deepEqual(yield* sql`SELECT state FROM request_writes ORDER BY rowid`, [
						{ state: "live" },
						{ state: "frozen" },
					]);
					assert.deepEqual(yield* sql`SELECT body FROM messages ORDER BY seq`, [{ body: "live" }, { body: "frozen" }]);
					assert.equal((yield* events.query({ since: 0, limit: 100, types: ["message.created"] })).items.length, 2);
					assert.equal(yield* Ref.get(lifecycle.mutations), 1);
					assert.equal(yield* Ref.get(lifecycle.requests), 1);
					// An operation started before response completion remains counted until its transaction finishes.
					yield* Ref.set(active, true);
					yield* Ref.set(lifecycle.state, "live");
					const entered = yield* Deferred.make<void>();
					const finish = yield* Deferred.make<void>();
					const pending = yield* ctx
						.mutate(
							Effect.gen(function* () {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(finish);
								yield* sql`INSERT INTO request_writes VALUES ('completing')`;
							}),
						)
						.pipe(Effect.provideService(RequestMutation, active), Effect.forkChild);
					yield* Deferred.await(entered);
					assert.equal(yield* Ref.get(lifecycle.mutations), 2);
					yield* Ref.set(active, false);
					yield* Ref.update(lifecycle.mutations, (count) => count - 1);
					yield* Ref.set(lifecycle.requests, 0);
					yield* Ref.set(lifecycle.state, "frozen");
					assert.equal(yield* Ref.get(lifecycle.mutations), 1);
					yield* Deferred.succeed(finish, undefined);
					yield* Fiber.join(pending);
					assert.equal(yield* Ref.get(lifecycle.mutations), 0);
					yield* Console.log("REQUEST_MUTATION_VERIFIED");
				}).pipe(Effect.provide(Layer.mergeAll(publicationLayer, pagesLayer(`${root}/pages`), lifecycleLayer)));
			}).pipe(
				Effect.provide(SqliteClient.layer({ filename: channel.filename, disableWAL: true })),
				Effect.provideService(BootChannel, channel),
			);
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
