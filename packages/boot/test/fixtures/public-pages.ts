import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { Console, Deferred, Effect, FileSystem, Fiber, Layer, Semaphore } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { Events, layer as eventsLayer } from "../../src/events.ts";
import { PublicPages, layer } from "../../src/public-pages.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing directory");
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(`${root}/pages/guide`, { recursive: true });
	yield* fs.writeFileString(`${root}/pages/guide/file.md`, "# Guide");
	const create = (isPublic: boolean) => {
		const database = new Database(`${root}/comms.db`);
		try {
			database.exec("CREATE TABLE topics(path TEXT,parent TEXT,meta TEXT,deleted_at INTEGER,archived_at INTEGER)");
			database
				.query("INSERT INTO topics VALUES('guide','','{\"public\":' || ? || '}',NULL,NULL)")
				.run(isPublic ? "true" : "false");
		} finally {
			database.close();
		}
	};
	create(true);
	const operationGate = yield* Semaphore.make(1),
		channelGate = yield* Semaphore.make(1);
	return yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		const policy = yield* PublicPages.pipe(
			Effect.provide(layer(root, operationGate, channelGate).pipe(Layer.provide(eventsLayer))),
		);
		const events = yield* Events.pipe(Effect.provide(eventsLayer));
		yield* events.reserve("pending-page-admission", 1, "fixture");
		let writes = 0;
		const publish = Effect.sync(() => {
			writes++;
			return "published once";
		});
		const waiting = yield* policy.withWrite(["pages/guide/file.md"], publish).pipe(Effect.forkScoped);
		yield* Effect.sleep("30 millis");
		const beforeSettlement = writes;
		yield* channelGate.withPermit(events.abort("pending-page-admission", "fixture"));
		const settled = yield* Fiber.join(waiting);
		yield* events.reserve("stuck-page-admission", 1, "fixture");
		const stuck = yield* policy.withWrite(["pages/guide/file.md"], publish).pipe(Effect.result);
		yield* channelGate.withPermit(events.abort("stuck-page-admission", "fixture"));
		const initial = (yield* policy.check("/p/guide/file.md")) !== null;
		const held = yield* Deferred.make<void>(),
			release = yield* Deferred.make<void>();
		const owner = yield* operationGate
			.withPermit(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
			.pipe(Effect.forkScoped);
		yield* Deferred.await(held);
		const blocked = yield* policy.check("/p/guide/file.md").pipe(Effect.result);
		yield* Deferred.succeed(release, undefined);
		yield* Fiber.join(owner);
		const after = (yield* policy.check("/p/guide/file.md")) !== null;
		const writeHeld = yield* Deferred.make<void>(),
			writeRelease = yield* Deferred.make<void>();
		const writing = yield* policy
			.withWrite(
				["pages/guide/file.md"],
				Deferred.succeed(writeHeld, undefined).pipe(Effect.andThen(Deferred.await(writeRelease))),
			)
			.pipe(Effect.forkScoped);
		yield* Deferred.await(writeHeld);
		const reservation = yield* channelGate
			.withPermit(Effect.succeed("admitted"))
			.pipe(Effect.timeout("25 millis"), Effect.result);
		yield* Deferred.succeed(writeRelease, undefined);
		yield* Fiber.join(writing);
		const update = (statement: string) => {
			const database = new Database(`${root}/comms.db`);
			try {
				database.exec(statement);
			} finally {
				database.close();
			}
		};
		update("UPDATE topics SET deleted_at=1 WHERE path='guide'");
		const deleted = (yield* policy.check("/p/guide/file.md")) === null;
		const refused = yield* policy.withWrite(["pages/guide/new.md"], Effect.succeed("must not run")).pipe(Effect.result);
		update("UPDATE topics SET deleted_at=NULL WHERE path='guide'");
		yield* operationGate.withPermit(
			Effect.gen(function* () {
				yield* fs.rename(`${root}/comms.db`, `${root}/old.db`);
				create(false);
			}),
		);
		const replacement = (yield* policy.check("/p/guide/file.md")) !== null;
		yield* fs.remove(`${root}/comms.db`);
		const missing = yield* policy.check("/p/guide/file.md").pipe(Effect.result);
		return {
			beforeSettlement,
			settled,
			writes,
			stuck: stuck._tag,
			initial,
			blocked: blocked._tag,
			after,
			reservation: reservation._tag,
			deleted,
			refused: refused._tag,
			replacement,
			missing: missing._tag,
			notCreated: !(yield* fs.exists(`${root}/comms.db`)),
		};
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
}).pipe(
	Effect.scoped,
	Effect.provide(BunServices.layer),
	Effect.flatMap((value) => Console.log(JSON.stringify(value))),
);
main.pipe(BunRuntime.runMain);
