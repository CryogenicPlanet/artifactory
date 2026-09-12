import { BunRuntime, BunServices } from "@effect/platform-bun";
import { parseDescriptor } from "@comms/storage/store";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { databaseLayer } from "./kernel/remote-database.ts";
import { initializeTransferApp } from "./kernel/transfer-app-initialize.ts";

// This entry travels with frozen editable source. It receives only the target app
// credential and guardian lease, never the immutable transfer configuration.
const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const store = yield* parseDescriptor(yield* Config.String("APP_STORE"));
	const epoch = yield* Config.String("WRITER_EPOCH");
	const engine = yield* Schema.decodeUnknownEffect(Schema.Literals(["sqlite", "pg", "mysql"]))(
		yield* Config.String("TRANSFER_SOURCE_ENGINE"),
	);
	const resultFile = yield* Config.String("TRANSFER_APP_RESULT");
	const source = yield* fs.realPath(import.meta.dirname);
	const result = yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* initializeTransferApp(sql, epoch, source, engine);
		}).pipe(Effect.provide(databaseLayer(store))),
	);
	const file = yield* fs.open(resultFile, { flag: "wx", mode: 0o640 });
	yield* file.writeAll(new TextEncoder().encode(JSON.stringify(result)));
	yield* file.sync;
	yield* (yield* fs.open(path.dirname(resultFile))).sync;
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provide(BunServices.layer));
program.pipe(
	Effect.catchCause(() => Effect.die("Offline app migration failed")),
	BunRuntime.runMain,
);
