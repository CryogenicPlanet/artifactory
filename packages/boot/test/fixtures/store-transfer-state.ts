import { clientLayer } from "@comms/storage/client";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { assertBootTransferState } from "../../src/store-transfer-state.ts";
import { appStoreIdentity, verifyAppIdentity } from "../../src/app-store-identity.ts";

const mode = process.argv[2] ?? "fresh";
BunRuntime.runMain(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		if (mode !== "fresh") yield* sql`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
		if (mode === "incomplete" || mode === "unknown" || mode === "complete")
			yield* sql`INSERT INTO settings VALUES('transfer_state',${mode === "incomplete" ? "in_progress" : mode})`;
		if (mode === "retired") yield* sql`INSERT INTO settings VALUES('transferred_to','private target')`;
		const before = yield* sql`SELECT name FROM sqlite_master ORDER BY name`;
		const result = yield* assertBootTransferState(sql).pipe(Effect.result);
		const after = yield* sql`SELECT name FROM sqlite_master ORDER BY name`;
		let identity;
		if (["incomplete", "unknown", "retired"].includes(mode)) {
			const service = yield* appStoreIdentity("/tmp/never-open-transfer-test.db");
			identity = yield* service.reserve.pipe(Effect.result);
			const reserved = yield* sql`SELECT key FROM settings WHERE key='app_store_adoption'`;
			if (reserved.length) return yield* Effect.die("Refusal reserved an identity");
		}
		if (mode === "app-retired") {
			yield* sql`CREATE TABLE store_identity(singleton INTEGER,store_id TEXT,initialized_at INTEGER,transferred_to TEXT)`;
			yield* sql`INSERT INTO store_identity VALUES(1,'11111111-1111-4111-8111-111111111111',1,'private target')`;
			identity = yield* verifyAppIdentity(
				{
					store_id: "11111111-1111-4111-8111-111111111111",
					initialized_at: 1,
					filename: "/tmp/unused",
					mode: "fresh",
					phase: "ready",
				},
				false,
			).pipe(Effect.result);
		}
		yield* Console.log(
			JSON.stringify({ result, identity, unchanged: JSON.stringify(before) === JSON.stringify(after) }),
		);
	}).pipe(
		Effect.provide(clientLayer({ _tag: "file", filename: ":memory:" })),
		Effect.scoped,
		Effect.provide(BunServices.layer),
	),
);
