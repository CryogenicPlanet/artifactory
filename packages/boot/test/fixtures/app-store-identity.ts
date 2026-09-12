import { BunRuntime, BunServices } from "@effect/platform-bun";
import { clientLayer } from "@comms/storage/client";
import { Console, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { appStoreIdentity, verifyAppIdentity } from "../../src/app-store-identity.ts";
import { AppRecovery, layer as recoveryLayer } from "../../src/app-recovery.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { DbOps, layer as backupLayer } from "../../src/db-ops.ts";

const root = process.argv[2];
if (!root) throw Error("Missing root");
const mode = process.argv[3];
const filename = `${root}/${process.argv[4] ?? "comms.db"}`;
const pause = Console.log("PAUSED").pipe(Effect.andThen(Effect.never));
const main = Effect.gen(function* () {
	yield* initializeBootSchema;
	const identity = yield* appStoreIdentity(filename, root);
	if (mode === "sweep") yield* (yield* DbOps).recoverStaging;
	if (mode === "reserve" || mode === "stamp") {
		const adoption = yield* identity.reserve;
		if (mode === "stamp")
			yield* Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`PRAGMA synchronous=FULL`;
					yield* sql.withTransaction(verifyAppIdentity(adoption, true));
				}).pipe(Effect.provide(clientLayer({ _tag: "file", filename }))),
			);
		return yield* pause;
	}
	if (mode === "restore" || mode === "restore-pause") {
		yield* identity.reserve;
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql`SELECT path,legacy_store_id,engine FROM backups WHERE id='saved'`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							path: Schema.String,
							legacy_store_id: Schema.NullOr(Schema.String),
							engine: Schema.Literals(["sqlite", "pg", "mysql"]),
						}),
					),
				),
			),
		);
		if (!rows[0]) return yield* Effect.die("Missing backup");
		yield* (yield* DbOps).restoreInto(rows[0]);
		if (mode === "restore-pause") return yield* pause;
	}
	yield* (yield* AppRecovery).prepare("next-epoch");
	return "ready";
}).pipe(
	Effect.provide(
		Layer.mergeAll(recoveryLayer(filename, root), backupLayer({ _tag: "file", filename }, root)).pipe(
			Layer.provideMerge(eventsLayer(Effect.void)),
		),
	),
	Effect.result,
	Effect.flatMap((result) => Console.log(JSON.stringify(result))),
	Effect.provide(clientLayer({ _tag: "file", filename: `${root}/boot.db` })),
	Effect.scoped,
	Effect.provide(BunServices.layer),
);
main.pipe(BunRuntime.runMain);
