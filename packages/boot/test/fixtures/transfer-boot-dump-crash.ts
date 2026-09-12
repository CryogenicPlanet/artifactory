import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { TransferSelection } from "@comms/storage/store-transfer-schema";
import { configuration } from "./remote-keeper-config.ts";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { remoteOwnerInventory } from "../../src/remote-owner-inventory.ts";
import { transferDumpJournal } from "../../src/transfer-dump-journal.ts";
import { postgresDatabaseProvision } from "../../src/postgres-database-provision.ts";
import { mysqlDatabaseProvision } from "../../src/mysql-database-provision.ts";
import { nativeCopyRunner } from "../../src/native-copy-process.ts";

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.DUMP_CRASH_ROOT ?? process.argv[2] ?? "");
	const phase = process.env.DUMP_CRASH_PHASE ?? process.argv[3] ?? "crash";
	assert.ok(phase === "crash" || phase === "reopen");
	const config = yield* configuration;
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const result = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { DUMP_CRASH_ROOT: root, DUMP_CRASH_PHASE: phase },
			}),
		).pipe(Effect.exit);
		if (phase === "crash") assert.equal(result._tag, "Failure", "Worker must be killed");
		else {
			assert.equal(result._tag, "Success");
			if (result._tag === "Success") assert.equal(Number(result.value), 0);
		}
		yield* Effect.scoped(remoteOwnerInventory(root));
		console.log(`BOOT_DUMP_${phase}_VERIFIED`);
		return;
	}
	const runtime = yield* remoteRuntime(config, root);
	const sql = runtime.bootSql;
	assert.equal((yield* sql<{ value: number }>`SELECT 1 AS value`)[0]?.value, 1);
	const selection: TransferSelection = {
		version: 1,
		transfer_id: "11111111-1111-4111-8111-111111111111",
		store_id: "22222222-2222-4222-8222-222222222222",
		data_directory: root,
		source: {
			engine: config.bootConnection.engine,
			endpoint: `${config.bootConnection.host}:${config.bootConnection.port}`,
			boot: config.boot.database,
			app: config.app.database,
		},
		target: { engine: "sqlite", endpoint: null, boot: `${root}/target-boot.db`, app: `${root}/target-app.db` },
	};
	const journal = yield* transferDumpJournal(selection, { boot: config.boot, app: config.app });
	const mysql = mysqlDatabaseProvision({
		created: () => Effect.die("No database creation expected"),
		owns: () => Effect.die("No database ownership expected"),
	});
	const provisioning: Effect.Effect<
		Effect.Success<typeof postgresDatabaseProvision> | Effect.Success<typeof mysql>,
		Effect.Error<typeof postgresDatabaseProvision> | Effect.Error<typeof mysql>,
		SqlClient.SqlClient
	> = config.boot._tag === "postgres" ? postgresDatabaseProvision : mysql;
	const provision = yield* provisioning.pipe(Effect.provideService(SqlClient.SqlClient, sql));
	if (phase === "reopen") {
		const records = yield* journal.list;
		assert.equal(records.length, 1);
		const record = records[0];
		assert.ok(record);
		const credential = yield* journal.credential(record.id);
		yield* runtime.assertAccountClosed(record.id, credential, {
			transferId: selection.transfer_id,
			resourceId: record.id,
		});
		const closed = yield* journal.close(record.id);
		yield* provision.revokeDump(closed);
		yield* provision.dropPrincipal(closed);
		yield* journal.finish(record.id);
		assert.equal((yield* sql`SELECT value FROM boot_dump_crash_evidence`).length, 1);
		yield* sql`DROP TABLE boot_dump_crash_evidence`;
		return;
	}
	// A dedicated disposable boot database only; CREATE deliberately refuses an existing fixture.
	yield* sql`CREATE TABLE boot_dump_crash_evidence(value INTEGER NOT NULL)`;
	yield* sql`INSERT INTO boot_dump_crash_evidence VALUES(42)`;
	const record = yield* journal.allocate("boot");
	const credential = yield* journal.credential(record.id);
	yield* provision.createPrincipal(record, credential);
	yield* provision.grantDump(record);
	yield* journal.ready(record.id);
	const reference = { transferId: selection.transfer_id, resourceId: record.id };
	const id = "e8".repeat(32);
	const remote = yield* runtime.reserveOwner(credential, id, "account", reference);
	// Private test control file; never put native or boot credentials in stdout.
	yield* fs.writeFileString(
		`${root}/ready.json`,
		JSON.stringify({
			worker: process.pid,
			root: runtime.rootAttempt,
			id,
			principal: record.principal,
			store: Redacted.value(credential.url),
		}),
		{ flag: "wx", mode: 0o600 },
	);
	const run = yield* nativeCopyRunner;
	yield* run({
		id,
		store: credential,
		remote,
		operation: "dump",
		path: yield* journal.pathFor(record.id),
		budgetMs: 60000,
	});
	return yield* Effect.die("Native fixture unexpectedly completed before worker SIGKILL");
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause(() => Effect.die("Boot dump crash fixture failed; credentials omitted")),
	BunRuntime.runMain,
);
