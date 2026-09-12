import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Layer, Path } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { assertChildAttemptsClosed, ChildAttempts, layer as attemptsLayer } from "../../src/child-attempts.ts";
import { KernelBoot } from "../../src/kernel-boot.ts";
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
	const id = "a".repeat(64);
	const receipt = path.join(directory, "attempts", `${id}.closed`);
	yield* fs.makeDirectory(path.dirname(receipt), { mode: 0o700 });
	const source = yield* SqliteClient.make({ filename: path.join(directory, "source.db"), disableWAL: true });
	yield* source`CREATE TABLE child_attempts(id TEXT, generation INTEGER, receipt TEXT,opened INTEGER,closed INTEGER,boot_id TEXT)`;
	yield* source`INSERT INTO child_attempts VALUES(${id},1,${receipt},1,0,'12345678-1234-4234-8234-123456789abc')`;
	const before = yield* fs.readFile(path.join(directory, "source.db"));
	const unchanged = Effect.gen(function* () {
		assert.deepEqual(Buffer.from(yield* fs.readFile(path.join(directory, "source.db"))), Buffer.from(before));
		assert.equal((yield* source`SELECT closed FROM child_attempts`)[0]?.closed, 0);
	});
	const refused = Effect.gen(function* () {
		assert.equal((yield* Effect.exit(assertChildAttemptsClosed(source, directory)))._tag, "Failure");
		yield* unchanged;
	});
	// A previous kernel ID is not transferable proof when the destination may be remote.
	yield* refused;
	yield* fs.writeFileString(receipt, "b".repeat(64));
	yield* refused;
	yield* fs.writeFileString(receipt, `${id}\n`);
	yield* refused;
	yield* fs.remove(receipt);
	const foreign = path.join(directory, "foreign");
	yield* fs.writeFileString(foreign, id);
	yield* fs.symlink(foreign, receipt);
	yield* refused;
	yield* fs.remove(receipt);
	yield* fs.writeFileString(receipt, id, { mode: 0o600 });
	yield* assertChildAttemptsClosed(source, directory);
	yield* unchanged;
	const target = yield* SqliteClient.make({ filename: path.join(directory, "target.db"), disableWAL: true });
	yield* target`CREATE TABLE child_attempts(id TEXT,generation INTEGER,receipt TEXT,opened INTEGER,closed INTEGER,boot_id TEXT)`;
	const rows = yield* source`SELECT * FROM child_attempts`;
	yield* target`INSERT INTO child_attempts ${target.insert(rows)}`;
	assert.deepEqual(yield* target`SELECT * FROM child_attempts`, rows);
	yield* Effect.gen(function* () {
		yield* (yield* ChildAttempts).recover;
	}).pipe(
		Effect.provide(
			attemptsLayer(directory, true).pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(SqlClient.SqlClient)(target),
						Layer.succeed(KernelBoot)({ id: "87654321-4321-4321-8321-abcdef123456" }),
					),
				),
			),
		),
	);
	assert.equal((yield* target`SELECT closed FROM child_attempts`)[0]?.closed, 1);
	yield* unchanged;
	yield* source`UPDATE child_attempts SET closed=2`;
	assert.equal((yield* Effect.exit(assertChildAttemptsClosed(source, directory)))._tag, "Failure");
	yield* Console.log("Read-only keeper closure and target reconciliation verified");
});
BunRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, Reactivity.layer))));
