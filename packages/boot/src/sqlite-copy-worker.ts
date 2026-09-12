import { BunRuntime, BunServices } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { Config, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqliteCopyConfiguration } from "./sqlite-copy-configuration.ts";

// Never loads editable code or spawns descendants. The keeper owns this one process.
const copy = Effect.gen(function* () {
	const encoded = yield* Config.Redacted("COMMS_SQLITE_COPY");
	const config = yield* Schema.decodeEffect(Schema.fromJsonString(SqliteCopyConfiguration))(Redacted.value(encoded));
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`PRAGMA busy_timeout=2000`;
			yield* sql`VACUUM INTO ${config.destination}`;
		}).pipe(Effect.provide(clientLayer({ _tag: "file", filename: config.source }, { readonly: true }))),
	);
	for (const name of [config.destination, path.dirname(config.destination)])
		yield* Effect.scoped(fs.open(name).pipe(Effect.flatMap((file) => file.sync)));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
copy.pipe(BunRuntime.runMain);
