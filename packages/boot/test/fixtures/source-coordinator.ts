import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { EditLock, layer as lockLayer } from "../../src/edit-lock.ts";
import { SourceFiles, layer as sourceLayer } from "../../src/source-files.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { SourceRejected } from "../../src/source-schema.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const scenario = yield* Schema.decodeUnknownEffect(
		Schema.Literals(["borrowed", "acceptance-failure", "cancelled", "publication-failure"]),
	)(process.argv[3]);
	const fs = yield* FileSystem.FileSystem;
	for (const directory of ["app", "selected", "pages"]) yield* fs.makeDirectory(`${root}/${directory}`);
	yield* fs.writeFileString(`${root}/app/main.ts`, "current");
	yield* fs.writeFileString(`${root}/selected/main.ts`, "selected");
	yield* fs.chmod(`${root}/app/main.ts`, 0o640);
	yield* fs.chmod(`${root}/selected/main.ts`, 0o750);
	yield* fs.writeFileString(`${root}/pages/index.md`, "page stays current");
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE coordinator_receipts (batch TEXT PRIMARY KEY)`;
		return yield* Effect.gen(function* () {
			const files = yield* SourceFiles;
			const lock = yield* EditLock;
			const held = (yield* lock.acquire("other-family", "other-agent")).value;
			const owner = { id: held.id, family: held.holder_family };
			yield* files.stage(owner, "app/main.ts", new TextEncoder().encode("unrelated staged repair"));
			const staged = (yield* lock.overlay(owner)).value;
			yield* lock.pin(owner);
			const acquire = files.prepareTrustedTree(owner, `${root}/selected`, "rahul");
			const checkBorrowed = Effect.gen(function* () {
				assert.deepEqual((yield* lock.overlay(owner)).value, staged);
				assert.equal((yield* lock.inspect).value?.cutover_in_flight, 1);
				assert.equal(yield* fs.readFileString(`${root}/pages/index.md`), "page stays current");
			});
			const receipt = (batch: string) => sql`INSERT INTO coordinator_receipts VALUES (${batch})`.pipe(Effect.asVoid);
			const publish = Effect.acquireUseRelease(
				acquire,
				(batch) => files.publishWithAcceptance(batch, receipt(batch)).pipe(Effect.as(batch)),
				(batch) => files.discard(batch).pipe(Effect.ignore),
			);
			if (scenario === "borrowed") {
				const batch = yield* publish;
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "selected");
				assert.deepEqual(yield* sql`SELECT batch FROM coordinator_receipts`, [{ batch }]);
				yield* checkBorrowed;
				yield* lock.finish(owner, { succeeded: false });
				assert.equal((yield* lock.inspect).value?.cutover_in_flight, 0);
				assert.deepEqual((yield* lock.overlay(owner)).value, staged);
			} else if (scenario === "acceptance-failure") {
				yield* sql`CREATE TRIGGER refuse_receipt BEFORE INSERT ON coordinator_receipts BEGIN SELECT RAISE(ABORT,'acceptance refused'); END`;
				const failed = yield* publish.pipe(Effect.result);
				assert.equal(failed._tag, "Failure");
				assert.deepEqual(yield* sql`SELECT * FROM source_batches`, []);
				assert.deepEqual(yield* sql`SELECT * FROM source_changes`, []);
				assert.deepEqual(yield* sql`SELECT * FROM coordinator_receipts`, []);
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "current");
				yield* checkBorrowed;
				yield* sql`DROP TRIGGER refuse_receipt`;
				yield* publish;
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "selected");
			} else if (scenario === "cancelled") {
				const acquired = yield* Deferred.make<void>();
				const fiber = yield* Effect.acquireUseRelease(
					acquire,
					() => Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
					(batch) => files.discard(batch).pipe(Effect.orDie),
				).pipe(Effect.forkScoped);
				yield* Deferred.await(acquired);
				yield* Fiber.interrupt(fiber);
				assert.deepEqual(yield* sql`SELECT * FROM source_batches`, []);
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "current");
				yield* checkBorrowed;
				// Reusing the same service catches a stranded in-memory proposal as well as an accidental unpin.
				yield* publish;
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "selected");
			} else {
				// Failure after file fsync but before journal completion models interrupted acceptance publication.
				yield* sql`CREATE TRIGGER refuse_history BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'history unavailable'); END`;
				const failed = yield* publish.pipe(Effect.result);
				assert.equal(failed._tag, "Failure");
				const receipts = yield* sql`SELECT batch FROM coordinator_receipts`.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ batch: Schema.String })))),
				);
				const batch = receipts[0]?.batch;
				assert.ok(batch);
				assert.deepEqual(yield* sql`SELECT state FROM source_batches WHERE id=${batch}`, [{ state: "publishing" }]);
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "selected");
				assert.deepEqual(yield* sql`SELECT * FROM versions`, []);
				assert.deepEqual(
					yield* sql`SELECT path,CAST(before AS TEXT) AS before_text,CAST(desired AS TEXT) AS desired_text,before_mode,desired_mode FROM source_changes WHERE batch=${batch} AND path='app/main.ts'`,
					[
						{
							path: "app/main.ts",
							before_text: "current",
							desired_text: "selected",
							before_mode: 0o640,
							desired_mode: 0o750,
						},
					],
				);
				assert.deepEqual(yield* sql`SELECT agent,lock_id FROM source_batches WHERE id=${batch}`, [
					{ agent: "rahul", lock_id: owner.id },
				]);
				yield* checkBorrowed;
				const missing = yield* files.completePublication("not-this-batch").pipe(Effect.result);
				assert.ok(missing._tag === "Failure");
				assert.ok(Schema.is(SourceRejected)(missing.failure));
				assert.equal(missing.failure.code, "batch_missing");
				assert.equal(missing.failure.path, "not-this-batch");
				yield* sql`DROP TRIGGER refuse_history`;
				yield* files.completePublication(batch);
				const history = yield* sql`SELECT id,path FROM versions ORDER BY id`;
				assert.equal(history.length, 2);
				assert.deepEqual(
					yield* sql`SELECT agent,CAST(previous_content AS TEXT) AS previous_text,CAST(content AS TEXT) AS content_text,previous_mode,mode FROM versions WHERE batch=${batch} AND path='app/main.ts'`,
					[{ agent: "rahul", previous_text: "current", content_text: "selected", previous_mode: 0o640, mode: 0o750 }],
				);
				assert.deepEqual(yield* sql`SELECT * FROM source_changes`, []);
				assert.deepEqual(yield* sql`SELECT state FROM source_batches WHERE id=${batch}`, [{ state: "published" }]);
				yield* fs.writeFileString(`${root}/app/main.ts`, "later accepted edit");
				yield* files.completePublication(batch);
				assert.equal(yield* fs.readFileString(`${root}/app/main.ts`), "later accepted edit");
				assert.deepEqual(yield* sql`SELECT id,path FROM versions ORDER BY id`, history);
				assert.deepEqual(yield* sql`SELECT batch FROM coordinator_receipts`, [{ batch }]);
			}
			return undefined;
		}).pipe(
			Effect.provide(sourceLayer(root).pipe(Layer.provideMerge(lockLayer), Layer.provide(eventsLayer(Effect.void)))),
		);
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db` })));
	yield* program;
	yield* Console.log(`source coordinator ${scenario} passed`);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
