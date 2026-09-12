import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { readTransaction, on } from "@comms/storage/dialect";
import { parseDescriptor } from "@comms/storage/store";
import { Context, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Ref, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { testStore } from "./test-store.ts";
import { initializeBootSchema } from "../../../boot/src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../../boot/src/events.ts";
import { remoteAppKernelOperations } from "../../../boot/src/app-kernel-schema.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { Publication, layer as publicationLayer } from "../../src/kernel/publication.ts";
import { initializeRemoteKernelSchema } from "../../src/kernel/schema.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { makeMessages } from "../../src/ext/core/messages.ts";
import { publishedMessages } from "../../src/ext/core/published-messages.ts";

async function main() {
	let phase = "connect";
	const program = Effect.gen(function* () {
		const engine = yield* Schema.decodeUnknownEffect(Schema.Literals(["pg", "mysql"]))(process.env.COMMS_TEST_ENGINE);
		const bootSql = yield* testStore({
			engine,
			config: process.env.COMMS_SNAPSHOT_BOOT_CONFIG,
			database: "comms_snapshot_boot",
			tables: [],
		});
		const sql = yield* testStore({
			engine,
			config: process.env.COMMS_SNAPSHOT_APP_CONFIG,
			database: "comms_snapshot_app",
			tables: [],
		});
		const fs = yield* FileSystem.FileSystem;
		const configFile = process.env.COMMS_SNAPSHOT_APP_CONFIG;
		assert(configFile);
		const config = yield* fs.readFileString(configFile).pipe(
			Effect.flatMap(
				Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({
							host: Schema.String,
							port: Schema.Int,
							username: Schema.String,
							password: Schema.String,
						}),
					),
				),
			),
		);
		const url = new URL(`${engine === "pg" ? "postgres" : "mysql"}://localhost/comms_snapshot_app`);
		url.hostname = config.host;
		url.port = String(config.port);
		url.username = config.username;
		url.password = config.password;
		const store = yield* parseDescriptor(url.href);
		const epoch = "a".repeat(64);
		phase = "boot schema";
		yield* initializeBootSchema.pipe(Effect.provideService(SqlClient.SqlClient, bootSql));
		const events = Context.get(
			yield* Layer.build(eventsLayer(Effect.void).pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, bootSql)))),
			Events,
		);
		phase = "app kernel";
		// This isolated schema fixture owns its app database; role separation is tested elsewhere.
		for (const operation of remoteAppKernelOperations(sql, config.username)) {
			if (operation.name.startsWith("grant:")) continue;
			yield* operation.run;
			assert(yield* operation.postcondition);
		}
		yield* sql`INSERT INTO kernel_writer(singleton,epoch) VALUES(1,${epoch})`;
		const entered = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const held = yield* Ref.make(false);
		const cached = yield* Ref.make((yield* events.state).published_through);
		const unavailable = () => new KernelError({ code: "boot_unavailable" });
		const channel: BootChannel["Service"] = {
			epoch,
			store,
			filename: null,
			generation: 1,
			backup: Effect.void,
			changed: (after) => events.changed(after).pipe(Effect.mapError(unavailable)),
			fence: Ref.get(cached).pipe(Effect.map((published_through) => ({ published_through }))),
			events: (input) => events.query(input).pipe(Effect.mapError(unavailable)),
			reserve: (transaction, count) => events.reserve(transaction, count, epoch).pipe(Effect.mapError(unavailable)),
			abort: (transaction) => events.abort(transaction, epoch).pipe(Effect.mapError(unavailable)),
			append: (batch) =>
				Effect.gen(function* () {
					if (yield* Ref.getAndSet(held, false)) {
						yield* Deferred.succeed(entered, undefined);
						yield* Deferred.await(release);
					}
					const result = yield* events.append(batch, epoch).pipe(Effect.mapError(unavailable));
					yield* Ref.set(cached, result.published_through);
					return result;
				}),
		};
		yield* Effect.gen(function* () {
			phase = "core schema";
			yield* initializeRemoteKernelSchema(sql, epoch);
			yield* initialize;
			const publication = Context.get(yield* Layer.build(publicationLayer), Publication);
			const messages = makeMessages(sql, publication, channel, yield* Crypto.Crypto);
			const who = { agent: "human", instance: "snapshot-test", request: "snapshot-test", kind: "human" as const };
			phase = "create message";
			const initial = yield* messages.create(who, { topic: "snapshot", body: "published-zero" });
			const firstFence = (yield* channel.fence).published_through;
			phase = "first edit";
			yield* Ref.set(held, true);
			// Actual domain mutation commits its previous image and outbox before calling append.
			const first = yield* messages.update(who, initial.id, { body: "published-one" }).pipe(Effect.forkScoped);
			yield* Effect.raceFirst(
				Deferred.await(entered),
				Fiber.join(first).pipe(Effect.andThen(Effect.fail(new Error("Writer did not reach append barrier")))),
			);
			const startSecond = yield* Deferred.make<void>();
			// Fork before entering the read transaction so the publisher never inherits its lease.
			const second = yield* Deferred.await(startSecond).pipe(
				Effect.andThen(messages.update(who, initial.id, { body: "published-two" })),
				Effect.forkScoped,
			);
			phase = "snapshot";
			const readImage = (ceiling: number) =>
				sql`SELECT body FROM (${publishedMessages(sql, ceiling)}) visible WHERE id=${initial.id}`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ body: Schema.String })))),
				);
			// Deliberately exercise the storage snapshot boundary directly: ordinary ctx.read
			// still shares Publication's mutation permit and does not promise concurrent writes.
			yield* readTransaction(
				sql,
				Effect.gen(function* () {
					yield* sql`SELECT epoch FROM kernel_writer`;
					const ceiling = (yield* channel.fence).published_through;
					assert.equal(ceiling, firstFence);
					assert.deepEqual(yield* sql`SELECT body FROM messages WHERE id=${initial.id}`, [{ body: "published-one" }]);
					assert.deepEqual(yield* readImage(ceiling), [{ body: "published-zero" }]);
					const session = yield* on(sql, {
						sqlite: () => sql`SELECT 0 AS id`,
						pg: () => sql`SELECT pg_backend_pid() AS id`,
						mysql: () => sql`SELECT CONNECTION_ID() AS id`,
					});
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(first);
					yield* Deferred.succeed(startSecond, undefined);
					yield* Fiber.join(second);
					assert((yield* channel.fence).published_through > ceiling);
					assert.deepEqual(yield* readImage(ceiling), [{ body: "published-zero" }]);
					assert.deepEqual(yield* sql`SELECT body FROM messages WHERE id=${initial.id}`, [{ body: "published-one" }]);
					assert.deepEqual(
						yield* on(sql, {
							sqlite: () => sql`SELECT 0 AS id`,
							pg: () => sql`SELECT pg_backend_pid() AS id`,
							mysql: () => sql`SELECT CONNECTION_ID() AS id`,
						}),
						session,
					);
				}),
			).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			assert.deepEqual(
				yield* readTransaction(
					sql,
					Effect.gen(function* () {
						yield* sql`SELECT epoch FROM kernel_writer`;
						return yield* readImage((yield* channel.fence).published_through);
					}),
				),
				[{ body: "published-two" }],
			);
			const published = yield* events.query({ since: 0, limit: 100, types: ["message.edited"] });
			assert.equal(published.items.length, 2);
			assert.equal((yield* events.state).pending_id, null);
			assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
		}).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provideService(BootChannel, channel));
		process.stdout.write(`NATIVE_READ_PUBLICATION_VERIFIED ${engine}\n`);
	}).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer)));
	await Effect.runPromise(program).catch(() => {
		throw new Error(`Native read/publication acceptance failed during ${phase}`);
	});
}
await main();
