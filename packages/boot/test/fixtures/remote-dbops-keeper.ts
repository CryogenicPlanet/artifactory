import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { FetchHttpClient } from "effect/unstable/http";
import { fileURLToPath } from "node:url";
import { configuration } from "./remote-keeper-config.ts";
import { launchRemoteRoot } from "../../src/remote-root-launcher.ts";
import { remoteRuntime } from "../../src/remote-runtime.ts";
import { remoteNativeCopy } from "../../src/remote-native-copy.ts";
import { remoteDbOps } from "../../src/remote-db-ops.ts";
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.realPath(process.env.GUARDIAN_TEST_ROOT ?? process.argv[2] ?? "");
	const config = yield* configuration;
	if (!process.env.COMMS_REMOTE_ROOT_CONFIG) {
		const code = yield* Effect.scoped(
			launchRemoteRoot(config, {
				dataDirectory: root,
				entry: fileURLToPath(import.meta.url),
				env: { GUARDIAN_TEST_ROOT: root },
			}),
		);
		if (Number(code) !== 0) return yield* Effect.die("Guarded native DbOps fixture failed");
		yield* Console.log("GUARDED_DBOPS_COPY_VERIFIED");
		return;
	}
	yield* Console.error("stage:runtime");
	const runtime = yield* remoteRuntime(config, root);
	const native = yield* remoteNativeCopy(runtime);
	yield* runtime.bootSql`CREATE TABLE IF NOT EXISTS settings(\`key\` VARCHAR(255) PRIMARY KEY,value LONGTEXT NOT NULL)`;
	const service = yield* remoteDbOps({
		store: Effect.succeed(config.app),
		bootStore: config.boot,
		dataDirectory: root,
		withStore: runtime.withStore,
		withNative: (request) =>
			Console.error("stage:native-start").pipe(
				Effect.andThen(native(request)),
				Effect.tap(() => Console.error("stage:native-return")),
			),
		assertAccountClosed: (id, store) =>
			Console.error("stage:account-check").pipe(
				Effect.andThen(runtime.assertAccountClosed(id, store)),
				Effect.tap(() => Console.error("stage:account-closed")),
			),
	}).pipe(Effect.provideService(SqlClient.SqlClient, runtime.bootSql));
	const before = yield* runtime.bootSql`SELECT value FROM settings WHERE \`key\` LIKE 'remote^_database:%' ESCAPE '^'`;
	const accountsBefore =
		yield* runtime.bootSql`SELECT USER,HOST FROM information_schema.USER_ATTRIBUTES WHERE LEFT(USER,8)='comms_t_' ORDER BY USER,HOST`;
	yield* Console.error("stage:clone");
	const bytes = yield* service.clone({ _tag: "file", filename: `${root}/copy.sql` });
	yield* Console.error("stage:clone-return");
	if (bytes <= 0n) return yield* Effect.die("Guarded copy produced no bytes");
	const rows = yield* runtime.bootSql`SELECT value FROM settings WHERE \`key\` LIKE 'remote^_database:%' ESCAPE '^'`;
	const accountsAfter =
		yield* runtime.bootSql`SELECT USER,HOST FROM information_schema.USER_ATTRIBUTES WHERE LEFT(USER,8)='comms_t_' ORDER BY USER,HOST`;
	if (JSON.stringify(accountsAfter) !== JSON.stringify(accountsBefore))
		return yield* Effect.die("Guarded copy left its temporary account");
	if (
		JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()) !==
		JSON.stringify(before.map((row) => JSON.stringify(row)).sort())
	)
		return yield* Effect.die("Guarded copy did not finish resource cleanup");
});
program.pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
	Effect.catchCause(() => Effect.die("Guarded native DbOps acceptance failed; credentials omitted")),
	BunRuntime.runMain,
);
