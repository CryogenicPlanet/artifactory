import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { portablePublicationStore } from "./portable-publication-store.ts";
import { type BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { makeMutate } from "../../src/kernel/mutate.ts";
import { makeOutboxRelay } from "../../src/kernel/outbox.ts";

const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite", "pg", "mysql"]))(
	process.env.COMMS_TEST_ENGINE,
);
let phase = "schemas";
await Effect.runPromise(
	Effect.gen(function* () {
		const { sql, bootSql, events, channel } = yield* portablePublicationStore({
			engine,
			appConfig: process.env.COMMS_MUTATION_APP_CONFIG,
			bootConfig: process.env.COMMS_MUTATION_BOOT_CONFIG,
			appDatabase: "comms_mutation_app",
			bootDatabase: "comms_mutation_boot",
		});
		const fault = yield* Ref.make<"reserve" | "append" | null>(null);
		const bodies = yield* Ref.make(0);
		const failed = new KernelError({ code: "boot_unavailable" });
		const boot: BootChannel["Service"] = {
			...channel,
			reserve: (id, count) =>
				Effect.gen(function* () {
					const result = yield* channel.reserve(id, count);
					if ((yield* Ref.get(fault)) === "reserve") {
						yield* Ref.set(fault, null);
						return yield* failed;
					}
					return result;
				}),
			append: (batch) =>
				Effect.gen(function* () {
					const result = yield* channel.append(batch);
					if ((yield* Ref.get(fault)) === "append") {
						yield* Ref.set(fault, null);
						return yield* failed;
					}
					return result;
				}),
		};
		const relay = makeOutboxRelay(sql, boot);
		const mutate = makeMutate(sql, yield* Crypto.Crypto, boot, relay, yield* Semaphore.make(1));
		const write = (key: string) =>
			mutate({
				idempotency: {
					instance: "portable",
					key,
					kind: "test.changed",
					input: key,
					outcome: Schema.fromJsonString(Schema.String),
				},
				body: (reserve) =>
					Effect.gen(function* () {
						yield* Ref.update(bodies, (n) => n + 1);
						// A write preceding a lost reservation acknowledgement must roll back too.
						yield* sql`INSERT INTO kv(ns,${sql("key")},value,updated_seq) VALUES ('portable',${key},'written',0)`;
						const { from } = yield* reserve(1);
						return {
							outcome: key,
							events: [
								{
									seq: from,
									at: 1,
									type: "test.changed",
									level: "info" as const,
									actor: "test",
									instance: "portable",
									generation: 1,
									request_id: key,
									topic: null,
									message_id: null,
									payload: { key },
								},
							],
						};
					}),
			});
		phase = "lost reservation acknowledgement";
		yield* Ref.set(fault, "reserve");
		const reserved = yield* write("reserve").pipe(Effect.result);
		assert.equal(reserved._tag, "Failure");
		if (reserved._tag === "Failure") assert.equal(reserved.failure, failed);
		assert.equal((yield* sql`SELECT * FROM kv`).length, 0);
		assert.equal((yield* sql`SELECT * FROM idempotency`).length, 0);
		assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 0);
		assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
		assert.equal((yield* events.state).pending_id, null);
		assert.equal((yield* bootSql`SELECT seq FROM events WHERE type='test.changed'`).length, 0);
		assert.equal(yield* write("reserve"), "reserve");
		phase = "lost append acknowledgement";
		yield* Ref.set(fault, "append");
		const appended = yield* write("append").pipe(Effect.result);
		assert.equal(appended._tag, "Failure");
		if (appended._tag === "Failure") assert.equal(appended.failure, failed);
		assert.equal((yield* sql`SELECT * FROM outbox`).length, 1);
		assert.equal((yield* sql`SELECT * FROM idempotency`).length, 2);
		assert.equal((yield* sql`SELECT * FROM kv`).length, 2);
		const before = yield* events.state;
		assert.equal(before.pending_id, null);
		const published = yield* bootSql`SELECT seq,event FROM events WHERE type='test.changed' ORDER BY seq`;
		assert.equal(published.length, 2);
		const attempts = yield* Ref.get(bodies);
		phase = "durable replay and cleanup";
		// A new mutate/relay instance must resolve solely from durable SQL receipts.
		const resumed = makeMutate(sql, yield* Crypto.Crypto, boot, makeOutboxRelay(sql, boot), yield* Semaphore.make(1));
		assert.equal(
			yield* resumed({
				idempotency: {
					instance: "portable",
					key: "append",
					kind: "test.changed",
					input: "append",
					outcome: Schema.fromJsonString(Schema.String),
				},
				body: () => Effect.die("Receipt replay executed body"),
			}),
			"append",
		);
		assert.equal(yield* Ref.get(bodies), attempts);
		assert.equal((yield* sql`SELECT * FROM outbox`).length, 0);
		assert.equal((yield* sql`SELECT * FROM mutation_batches`).length, 2);
		assert.deepEqual(yield* events.state, before);
		assert.deepEqual(yield* bootSql`SELECT seq,event FROM events WHERE type='test.changed' ORDER BY seq`, published);
		assert.equal(yield* write("append"), "append");
		assert.equal(yield* Ref.get(bodies), attempts);
		process.stdout.write(`PORTABLE_MUTATION_VERIFIED ${engine}\n`);
	}).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer))),
).catch(() => {
	throw new Error(`Portable mutation failed during ${phase}`);
});
