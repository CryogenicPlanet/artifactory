import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, Layer, Logger, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { makeEventStorage } from "../../src/event-storage.ts";
import { SqlClient } from "effect/unstable/sql";
import type { StorageVolume } from "../../src/storage-volume.ts";

const Input = Schema.Struct({
	capacity: Schema.Int,
	unavailable: Schema.optionalKey(Schema.Boolean),
	legacy: Schema.optionalKey(Schema.Boolean),
	policyAfterPrune: Schema.optionalKey(Schema.String),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const result = yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		if (input.legacy) {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`PRAGMA auto_vacuum=NONE`;
			yield* sql`VACUUM`;
		}
		const volume: StorageVolume = input.unavailable
			? { status: "unavailable", reason: "measurement_failed" }
			: { status: "available", capacity_bytes: input.capacity, available_bytes: input.capacity };
		const storage = yield* makeEventStorage(Effect.succeed(volume));
		const initial = yield* storage.admit.pipe(Effect.result);
		yield* storage.prune;
		if (input.policyAfterPrune !== undefined) {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO settings(key,value) VALUES('storage_policy',${input.policyAfterPrune})
				ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
		}
		const admission = yield* storage.admit.pipe(Effect.result);
		return { initial, status: yield* storage.status, admission };
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })));
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result));
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([]))));
main.pipe(BunRuntime.runMain);
