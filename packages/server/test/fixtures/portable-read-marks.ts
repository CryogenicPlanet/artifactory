import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Console, Deferred, Effect, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import type { Message } from "@comms/protocol/messages";
import { testStore } from "./test-store.ts";
import { BootChannel, KernelError } from "../../src/kernel/boot-channel.ts";
import { Lifecycle, type State } from "../../src/kernel/lifecycle.ts";
import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { Messages, layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { extensionCapabilities } from "../../src/ext/core/capabilities.ts";
import { layer as pagesLayer } from "../../src/ext/core/pages.ts";
import { markView } from "../../src/ext/core/read-view.ts";

const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite", "pg", "mysql"]))(process.argv[2]);
const unexpected = () => Effect.die("Read marks must not invoke boot event capabilities");
const boot: BootChannel["Service"] = {
	epoch: "read-mark-epoch",
	generation: 1,
	filename: null,
	store: { _tag: "file", filename: "/unused/read-marks.db" },
	backup: unexpected(),
	fence: Effect.succeed({ published_through: 12 }),
	changed: unexpected,
	events: unexpected,
	reserve: unexpected,
	append: unexpected,
	abort: unexpected,
};
const who = { agent: "reader", instance: "session", request: "read", kind: "human" as const };
const item = (topic: string, seq: number): typeof Message.Type => ({
	id: `message-${seq}`,
	seq,
	topic,
	agent: "writer",
	instance: "writer-session",
	body: "visible",
	tags: [],
	meta: {},
	created_at: 1,
	edited_at: null,
	deleted_at: null,
});
const main = Effect.gen(function* () {
	yield* Console.error("read-mark stage: store");
	const sql = yield* testStore({
		engine,
		config: process.env.COMMS_READ_MARK_CONFIG,
		database: "comms_read_marks",
		tables: ["reads", "outbox", "mutation_batches", "idempotency", "kernel_writer"],
	});
	yield* Console.error("read-mark stage: tables");
	// Supply the mutation protocol's physical preconditions; migration ladders are tested separately.
	yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
	yield* sql`INSERT INTO kernel_writer VALUES(1,${boot.epoch})`;
	yield* sql`CREATE TABLE ${sql("reads")}(instance VARCHAR(128),topic VARCHAR(255),seq BIGINT NOT NULL,PRIMARY KEY(instance,topic))`;
	yield* sql`CREATE TABLE mutation_batches(id VARCHAR(128) PRIMARY KEY,from_seq BIGINT,to_seq BIGINT,count BIGINT)`;
	yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id VARCHAR(128),event TEXT,shipped_at BIGINT)`;
	yield* sql`CREATE TABLE idempotency(expires_at BIGINT)`;
	yield* Console.error("read-mark stage: services");
	const state = yield* Ref.make<State>("live");
	const lifecycle = Layer.mock(Lifecycle, {
		initial: "starting",
		drained: yield* Deferred.make<void>(),
		state,
		gate: yield* Semaphore.make(1),
		mutations: yield* Ref.make(0),
		requests: yield* Ref.make(0),
		healthy: yield* Ref.make(true),
	});
	const pages = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "comms-read-mark-pages-" });
	yield* Effect.gen(function* () {
		yield* Console.error("read-mark stage: marking");
		const messages = yield* Messages;
		const ctx = (yield* extensionCapabilities)("read-mark-parity", who, false);
		const rows = sql`SELECT instance,topic,seq FROM ${sql("reads")} ORDER BY instance,topic`;
		const unchangedEvents = Effect.gen(function* () {
			assert.deepEqual(yield* sql`SELECT * FROM outbox`, []);
			assert.deepEqual(yield* sql`SELECT * FROM mutation_batches`, []);
			assert.deepEqual(yield* sql`SELECT * FROM idempotency`, []);
		});
		yield* messages.mark(who, { topic: "board", seq: 3 });
		yield* messages.mark(who, { topic: "board", seq: 1 });
		yield* markView(ctx, [item("board/thread", 9), item("elsewhere", 12)], "board");
		yield* markView(ctx, [item("board", 4)], "board");
		yield* messages.mark({ ...who, instance: "other" }, { topic: "board", seq: 2 });
		const expected = [
			{ instance: "other", topic: "board", seq: 2 },
			{ instance: "session", topic: "board", seq: 9 },
		];
		assert.deepEqual(yield* rows, expected);
		yield* Console.error("read-mark stage: admission");
		yield* Ref.set(state, "frozen");
		yield* markView(ctx, [item("board", 12)], "board");
		assert.deepEqual(yield* rows, expected);
		yield* Ref.set(state, "accepted");
		yield* markView(ctx, [item("board", 12)], "board");
		const accepted = [
			{ instance: "other", topic: "board", seq: 2 },
			{ instance: "session", topic: "board", seq: 12 },
		];
		assert.deepEqual(yield* rows, accepted);
		const ahead = yield* markView(ctx, [item("board", 13)], "board").pipe(Effect.result);
		assert.equal(ahead._tag, "Failure");
		if (ahead._tag === "Failure")
			assert.equal(Schema.is(KernelError)(ahead.failure) && ahead.failure.code, "cursor_ahead");
		yield* unchangedEvents;
		yield* Console.error("read-mark stage: stale epoch");
		yield* sql`UPDATE kernel_writer SET epoch='replacement'`;
		for (const operation of [
			messages.mark(who, { topic: "new", seq: 12 }),
			markView(ctx, [item("board", 12)], "board"),
		]) {
			const rejected = yield* operation.pipe(Effect.result);
			assert.equal(rejected._tag, "Failure");
			if (rejected._tag === "Failure")
				assert.equal(Schema.is(KernelError)(rejected.failure) && rejected.failure.code, "stale_writer");
		}
		assert.deepEqual(yield* rows, accepted);
		yield* unchangedEvents;
	}).pipe(
		Effect.provide(messagesLayer.pipe(Layer.provideMerge(publicationLayer))),
		Effect.provide(pagesLayer(pages)),
		Effect.provide(lifecycle),
		Effect.provideService(SqlClient.SqlClient, sql),
		Effect.provideService(BootChannel, boot),
	);
}).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer)));
await Effect.runPromise(main.pipe(Effect.catchCause(() => Effect.die("Portable read-mark assertion failed"))));
process.stdout.write("PORTABLE_READ_MARKS_VERIFIED\n");
