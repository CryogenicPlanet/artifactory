import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { preflightTransferAppSource, runTransferApp } from "../../../boot/src/transfer-app-launcher.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
	const transfer = path.join(root, "transfers", "12345678-1234-4234-8234-123456789abc");
	yield* fs.makeDirectory(transfer, { recursive: true });
	const store = { _tag: "file", filename: path.join(root, "comms.db") } as const;
	const epoch = "a".repeat(64);
	yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch TEXT NOT NULL)`;
			yield* sql`INSERT INTO kernel_writer VALUES(1,${epoch})`;
			yield* sql`CREATE TABLE mutation_batches(id TEXT PRIMARY KEY,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,count INTEGER NOT NULL)`;
			yield* sql`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,transaction_id TEXT NOT NULL,event TEXT NOT NULL,shipped_at INTEGER)`;
			yield* sql`CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY,store_id TEXT NOT NULL,initialized_at INTEGER NOT NULL,transferred_to TEXT)`;
			yield* sql`INSERT INTO store_identity VALUES(1,'aabbccdd-1234-4567-89ab-0123456789ab',1,NULL)`;
		}).pipe(Effect.provide(SqliteClient.layer({ filename: store.filename }))),
	);
	const source = yield* fs.realPath(path.resolve(import.meta.dirname, "../../src"));
	const options = {
		sourceDirectory: source,
		transferDirectory: transfer,
		dataDirectory: root,
		targetStore: store,
		epoch,
		sourceEngine: "pg",
		attempt: "b".repeat(64),
		isolated: false,
	} as const;
	yield* preflightTransferAppSource(source);
	const result = yield* Schema.decodeEffect(
		Schema.fromJsonString(
			Schema.Struct({
				core: Schema.Array(Schema.Struct({ migration_id: Schema.Number })),
				extensionProofs: Schema.Array(
					Schema.Struct({ extension: Schema.String, sourceChecksum: Schema.String, targetChecksum: Schema.String }),
				),
			}),
		),
	)(yield* runTransferApp(options));
	assert.equal(result.core.at(-1)?.migration_id, 14);
	assert(result.extensionProofs.length > 0);
	assert.equal(yield* fs.readFileString(path.join(root, "attempts", `${options.attempt}.closed`)), options.attempt);
	assert.equal((yield* runTransferApp(options).pipe(Effect.result))._tag, "Failure");
	assert.equal(
		(yield* runTransferApp({ ...options, attempt: "c".repeat(64), epoch: `${epoch}\n` }).pipe(Effect.result))._tag,
		"Failure",
	);
	const failedSource = path.join(root, "failure");
	yield* fs.makeDirectory(path.join(failedSource, "kernel"), { recursive: true });
	yield* fs.writeFileString(path.join(failedSource, "kernel/transfer-app-initialize.ts"), "");
	yield* fs.writeFileString(
		path.join(failedSource, "transfer-app-worker.ts"),
		`import {writeFileSync} from 'node:fs'; if(process.env.BOOT_DATABASE_URL || process.env.COMMS_REMOTE_TRANSFER_CONFIG || process.env.COMMS_CHILD_CONFIG) throw Error('Leaked config'); writeFileSync(process.env.TRANSFER_APP_RESULT,'{}');process.exit(7);`,
	);
	const failed = { ...options, sourceDirectory: failedSource, attempt: "d".repeat(64) };
	assert.equal((yield* runTransferApp(failed).pipe(Effect.result))._tag, "Failure");
	assert.equal(yield* fs.readFileString(path.join(root, "attempts", `${failed.attempt}.closed`)), failed.attempt);
	yield* fs.writeFileString(
		path.join(failedSource, "transfer-app-worker.ts"),
		`import {writeFileSync,readSync} from 'node:fs'; if(process.env.BOOT_DATABASE_URL || process.env.COMMS_REMOTE_TRANSFER_CONFIG || process.env.COMMS_CHILD_CONFIG) throw Error('Leaked config'); if(readSync(0,Buffer.alloc(1),0,1,null)!==0) throw Error('Leaked stdin');writeFileSync(process.env.TRANSFER_APP_RESULT,'{"privateConfigAbsent":true}');`,
	);
	const probe = yield* runTransferApp({ ...options, sourceDirectory: failedSource, attempt: "e".repeat(64) });
	assert.equal(probe, '{"privateConfigAbsent":true}');
	yield* fs.writeFileString(
		path.join(failedSource, "transfer-app-worker.ts"),
		`import {writeFileSync} from 'node:fs'; writeFileSync(process.env.TRANSFER_APP_RESULT,'{}');setInterval(()=>{},1000);`,
	);
	const hanging = { ...options, sourceDirectory: failedSource, attempt: "f".repeat(64) };
	assert.equal((yield* runTransferApp(hanging).pipe(Effect.timeout("1 second"), Effect.result))._tag, "Failure");
	assert.equal(yield* fs.readFileString(path.join(root, "attempts", `${hanging.attempt}.closed`)), hanging.attempt);

	yield* fs.writeFileString(
		path.join(failedSource, "transfer-app-worker.ts"),
		`import {writeFileSync} from 'node:fs'; writeFileSync(process.env.TRANSFER_APP_RESULT,'x'.repeat(1048577));`,
	);
	assert.equal(
		(yield* runTransferApp({ ...options, sourceDirectory: failedSource, attempt: "1".repeat(64) }).pipe(Effect.result))
			._tag,
		"Failure",
	);
	console.log("TRANSFER_APP_LAUNCHER_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
