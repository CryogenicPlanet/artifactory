import { layer as publicationLayer } from "../../src/kernel/publication.ts";
import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, type Batch, KernelError } from "../../src/kernel/boot-channel.ts";
import { initialize } from "../../src/ext/core/schema.ts";
import { reconstructPublicPages } from "../../src/ext/core/public-page-policy.ts";
import { layer as messagesLayer } from "../../src/ext/core/messages.ts";
import { layer as lifecycleLayer } from "../../src/kernel/lifecycle.ts";
import { Pages, layer as pagesLayer } from "../../src/ext/core/pages.ts";

const program = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const fs = yield* FileSystem.FileSystem;
	let next = 1;
	let ceiling = 0;
	let fail = true;
	const published: Batch[] = [];
	let grants: readonly string[] = [];
	const ranges = new Map<string, { transaction: string; from: number; to: number }>();
	const channel = (epoch: string): BootChannel["Service"] & { readonly filename: string } => ({
		epoch,
		store: { _tag: "file", filename: `${root}/app.db` },
		filename: `${root}/app.db`,
		generation: 1,
		backup: Effect.void,
		changed: () => Effect.never,
		fence: Effect.sync(() => ({ published_through: ceiling })),
		events: () => Effect.succeed({ items: [], cursor: ceiling, timed_out: false, drained: false }),
		reserve: (transaction, count) =>
			Effect.sync(() => {
				const previous = ranges.get(transaction);
				if (previous) return previous;
				assert.equal(count, 1);
				const range = { transaction, from: next, to: next + count - 1 };
				next += count;
				ranges.set(transaction, range);
				return range;
			}),
		append: (batch) =>
			Effect.gen(function* () {
				if (!published.some((previous) => previous.transaction === batch.transaction)) {
					published.push(batch);
					assert.equal(batch.events.length, 1);
					const event = batch.events[0];
					assert.equal(event?.type, "pages.public");
					assert.equal(event?.topic, null);
					grants = (yield* Schema.decodeUnknownEffect(Schema.Struct({ paths: Schema.Array(Schema.String) }))(
						event?.payload,
					).pipe(Effect.orDie)).paths;
				}
				ceiling = batch.to;
				if (fail) {
					fail = false;
					return yield* new KernelError({ code: "boot_unavailable" });
				}
				return { published_through: ceiling };
			}),
		abort: () => Effect.void,
	});
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,'first')`;
		yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER,to_seq INTEGER,count INTEGER)`;
		yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT,event TEXT,shipped_at INTEGER)`;
		const seed = Effect.gen(function* () {
			yield* initialize;
			for (let index = 0; index < 300; index++) {
				const path = `guide/public-${String(index).padStart(3, "0")}`;
				yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq) VALUES(${path},'guide',${path.slice(6)},${JSON.stringify({ public: true, filler: index < 10 ? "x".repeat(120000) : "" })},0,0,0)`;
			}
			for (const [path, meta, deleted] of [
				["guide", "{}", null],
				["guide/private", "{}", null],
				["guide/string", '{"public":"true"}', null],
				["guide/number", '{"public":1}', null],
				["guide/false", '{"public":false}', null],
				["guide/null", '{"public":null}', null],
				["guide/node_modules/hidden", '{"public":true}', null],
				["guide/../escape", '{"public":true}', null],
				["gone", '{"public":true}', 1],
				["gone/child", '{"public":true}', null],
			] as const)
				yield* sql`INSERT INTO topics(path,parent,name,meta,last_seq,created_at,updated_seq,deleted_at)
			VALUES(${path},${path.includes("/") ? path.split("/")[0] : null},${path.split("/").at(-1)},${meta},0,0,0,${deleted})`;
		});
		yield* seed.pipe(Effect.provideService(BootChannel, channel("first")));
		const reconstruct = (epoch: string) =>
			reconstructPublicPages.pipe(
				Effect.provide(Layer.merge(messagesLayer.pipe(Layer.provideMerge(publicationLayer)), lifecycleLayer)),
				Effect.provideService(BootChannel, channel(epoch)),
			);
		assert.equal((yield* reconstruct("first").pipe(Effect.result))._tag, "Failure");
		yield* reconstruct("first");
		assert.equal(published.length, 1);
		assert.equal(grants.length, 300);
		assert.equal(grants.includes("guide/node_modules/hidden"), false);
		assert.equal(grants.includes("guide/../escape"), false);
		assert.ok(Buffer.byteLength(JSON.stringify(published[0])) < 10000, "snapshot contains paths, not topic metadata");
		yield* reconstruct("first");
		assert.equal(published.length, 1, "same epoch receipt does not republish");
		yield* sql`UPDATE topics SET meta='{}' WHERE path='guide/public-000'`;
		yield* sql`DELETE FROM topics WHERE path='guide/public-002'`;
		yield* sql`UPDATE topics SET deleted_at=1 WHERE path='guide/public-003'`;
		yield* sql`UPDATE kernel_writer SET epoch='second'`;
		yield* reconstruct("second");
		assert.equal(published.length, 2, "fresh epoch publishes one complete replacement");
		assert.equal(grants.length, 297);
		for (const path of ["guide/public-000", "guide/public-002", "guide/public-003"])
			assert.equal(grants.includes(path), false, "snapshot drops privatized, physically removed and deleted topics");
		assert.deepEqual(yield* sql`SELECT DISTINCT updated_seq FROM topics`, [{ updated_seq: 0 }]);
		for (const path of ["guide/public-001", "guide/private", "guide/string", "gone/child"]) {
			yield* fs.makeDirectory(`${root}/pages/${path}`, { recursive: true });
			yield* fs.writeFileString(`${root}/pages/${path}/index.md`, "page");
		}
		yield* Effect.gen(function* () {
			const pages = yield* Pages;
			assert.equal(yield* pages.publicTopic("guide/public-001", ceiling), true);
			for (const path of ["guide/private", "guide/string", "guide/number", "guide/false", "guide/null"])
				assert.equal(yield* pages.publicTopic(path, ceiling), false, "only JSON boolean true grants public access");
			assert.deepEqual(
				(yield* pages.entries("guide", true)).map((entry) => entry.name),
				["public-001"],
			);
			// A committed, unpublished metadata change uses the prior published image for listings.
			yield* sql`UPDATE topics SET meta='{"public":true}',previous='{"meta":{},"archived_at":null,"deleted_at":null}',updated_seq=999999 WHERE path='guide/private'`;
			assert.deepEqual(
				(yield* pages.entries("guide", true)).map((entry) => entry.name),
				["public-001"],
			);
			assert.equal((yield* pages.resolve("gone/child").pipe(Effect.result))._tag, "Failure");
		}).pipe(Effect.provide(pagesLayer(`${root}/pages`)), Effect.provideService(BootChannel, channel("second")));
		const beforeOverflow = ranges.size;
		yield* sql`DELETE FROM topics`;
		yield* sql`WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<4096)
		 INSERT INTO topics(path,name,meta,last_seq,created_at,updated_seq)
		 SELECT 'public-'||value,'public-'||value,'{"public":true}',0,0,0 FROM n`;
		yield* sql`UPDATE kernel_writer SET epoch='count-limit'`;
		const countLimit = yield* reconstruct("count-limit").pipe(Effect.result);
		assert.equal(countLimit._tag, "Failure");
		if (countLimit._tag === "Failure")
			assert.equal(countLimit.failure._tag === "KernelError" && countLimit.failure.code, "public_pages_limit");
		assert.equal(ranges.size, beforeOverflow, "count overflow must fail before reserving a sequence");
		yield* sql`DELETE FROM topics`;
		yield* sql`INSERT INTO topics(path,name,meta,last_seq,created_at,updated_seq) VALUES(${"x".repeat(524288)},'large','{"public":true}',0,0,0)`;
		yield* sql`UPDATE kernel_writer SET epoch='byte-limit'`;
		const byteLimit = yield* reconstruct("byte-limit").pipe(Effect.result);
		assert.equal(byteLimit._tag, "Failure");
		if (byteLimit._tag === "Failure")
			assert.equal(byteLimit.failure._tag === "KernelError" && byteLimit.failure.code, "public_pages_limit");
		assert.equal(ranges.size, beforeOverflow, "encoded payload overflow must fail before reservation");
		yield* sql`DELETE FROM topics`;
		yield* sql`UPDATE kernel_writer SET epoch='empty'`;
		yield* reconstruct("empty");
		assert.deepEqual(grants, [], "empty authoritative set revokes every previous grant");
		assert.equal(published.length, 3);
		yield* reconstruct("empty");
		assert.equal(published.length, 3, "empty snapshot replay is also idempotent");
		yield* Console.log("PUBLIC_PAGE_POLICY_VERIFIED");
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/app.db`, disableWAL: true })));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
