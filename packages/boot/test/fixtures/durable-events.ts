/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditLock, layer as lockLayer } from "../../src/edit-lock.ts";
import { Events, layer as eventsLayer } from "../../src/events.ts";
import { Generations, layer as generationsLayer } from "../../src/generations.ts";
import { SourceFiles, layer as sourceLayer } from "../../src/source-files.ts";

const root = process.argv[2];
const scenario = process.argv[3];
if (!root) throw new Error("Missing data directory");
const program = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const work = Effect.gen(function* () {
		const locks = yield* EditLock;
		const events = yield* Events;
		const generations = yield* Generations;
		const sources = yield* SourceFiles;
		const fs = yield* FileSystem.FileSystem;
		const count = (type: string) =>
			sql`SELECT count(*) AS n FROM events WHERE type=${type}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })))),
				Effect.map((rows) => rows[0]?.n ?? -1),
			);
		const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.exit,
				Effect.map((exit) => assert.equal(exit._tag, "Failure")),
			);
		if (scenario === "lock") {
			yield* sql`CREATE TRIGGER refuse_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event failure'); END`;
			yield* failure(locks.acquire("family", "codex"));
			assert.equal((yield* locks.inspect).value, null);
			assert.equal((yield* events.state).next, 1);
			yield* sql`DROP TRIGGER refuse_event`;
			const lock = (yield* locks.acquire("family", "codex")).value;
			const owner = { id: lock.id, family: lock.holder_family };
			yield* locks.stage(owner, "app/file.ts", new TextEncoder().encode("private source"));
			yield* sql`UPDATE edit_lock SET expires=0`;
			yield* failure(locks.stage(owner, "app/file.ts", null));
			assert.equal(yield* count("lock.expired"), 1);
			assert.equal(yield* count("fs.staged"), 1);
			assert.equal((yield* locks.inspect).value, null);
			assert.equal(yield* count("lock.expired"), 1);
			const recovered = (yield* locks.acquire("family", "codex")).value;
			const held = { id: recovered.id, family: recovered.holder_family };
			yield* locks.pin(held);
			yield* locks.breakLock(held.id);
			yield* locks.breakLock(held.id);
			assert.equal(yield* count("lock.broken"), 1);
			yield* locks.recover;
			yield* locks.recover;
			// Recovery completes the deferred break once; it is not a separate interruption.
			assert.equal(yield* count("lock.broken"), 2);
			assert.equal(yield* count("lock.interrupted"), 0);
			assert.equal((yield* locks.inspect).value, null);
			const interrupted = (yield* locks.acquire("family", "codex")).value;
			yield* locks.pin({ id: interrupted.id, family: interrupted.holder_family });
			yield* locks.recover;
			yield* locks.recover;
			assert.equal(yield* count("lock.interrupted"), 1);
			assert.equal((yield* locks.inspect).value, null);
			const text = yield* sql`SELECT event FROM events`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ event: Schema.String })))),
			);
			assert.ok(text.every((row) => !row.event.includes("private source")));
		} else if (scenario === "fence") {
			const range = yield* events.reserve("pending", 2, "attempt");
			const lock = (yield* locks.acquire("family", "codex")).value;
			const owner = { id: lock.id, family: lock.holder_family };
			yield* locks.release(owner);
			assert.equal((yield* events.state).published_through, 0);
			assert.equal((yield* events.query({ since: 0, limit: 10 })).items.length, 0);
			yield* events.abort(range.transaction, "attempt");
			const page = yield* events.query({ since: 0, limit: 10 });
			assert.deepEqual(
				page.items.map((event) => event.type),
				["lock.acquired", "lock.released"],
			);
			assert.deepEqual(
				page.items.map((event) => event.seq),
				[3, 4],
			);
		} else if (scenario === "generation") {
			const row = yield* generations.reserve("server.js");
			yield* sql`CREATE TRIGGER refuse_live BEFORE INSERT ON events WHEN NEW.type='generation.live' BEGIN SELECT RAISE(ABORT, 'event failure'); END`;
			yield* failure(generations.healthy(row.n));
			assert.equal((yield* generations.list)[0]?.status, "starting");
			assert.equal((yield* generations.list)[0]?.good, 0);
			yield* sql`DROP TRIGGER refuse_live`;
			yield* generations.healthy(row.n);
			yield* generations.healthy(row.n);
			assert.equal(yield* count("generation.live"), 1);
			yield* generations.failed(row.n, "failed", "stderr");
			yield* generations.failed(row.n, "failed", "stderr");
			assert.equal(yield* count("generation.failed"), 1);
			yield* generations.starting(row.n);
			yield* generations.healthy(row.n);
			yield* generations.recover;
			yield* generations.recover;
			assert.equal(yield* count("generation.retired"), 1);
			assert.equal((yield* generations.list)[0]?.good, 1);
			const pending = yield* generations.reserve("next.js");
			yield* generations.recover;
			yield* generations.recover;
			assert.equal((yield* generations.list).find((value) => value.n === pending.n)?.status, "failed");
			assert.equal(yield* count("generation.failed"), 2);
		} else if (scenario === "source") {
			yield* fs.makeDirectory(`${root}/pages`, { recursive: true });
			yield* fs.writeFileString(`${root}/pages/readme.md`, "before");
			const id = yield* sources.preparePages("codex", [
				{ path: "pages/readme.md", content: new TextEncoder().encode("after") },
			]);
			yield* sql`CREATE TRIGGER refuse_source BEFORE INSERT ON events WHEN NEW.type='fs.write' BEGIN SELECT RAISE(ABORT, 'event failure'); END`;
			yield* failure(sources.publish(id));
			assert.equal(yield* fs.readFileString(`${root}/pages/readme.md`), "after");
			assert.equal(yield* count("fs.write"), 0);
			const pending = yield* sql`SELECT state FROM source_batches WHERE id=${id}`;
			assert.equal(pending[0]?.state, "publishing");
			assert.equal((yield* sql`SELECT id FROM versions`).length, 0);
			yield* sql`DROP TRIGGER refuse_source`;
			yield* sources.recover;
			yield* sources.recover;
			assert.equal(yield* count("fs.write"), 1);
			assert.equal((yield* sql`SELECT id FROM versions`).length, 1);
			assert.equal((yield* sql`SELECT batch FROM source_changes`).length, 0);
		} else throw new Error("Unknown scenario");
		yield* Console.log("PASS");
	});
	const eventServices = eventsLayer(Effect.void);
	yield* work.pipe(
		Effect.provide(
			Layer.mergeAll(generationsLayer, sourceLayer(root).pipe(Layer.provideMerge(lockLayer))).pipe(
				Layer.provideMerge(eventServices),
			),
		),
	);
}).pipe(
	Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
);
program.pipe(BunRuntime.runMain);
