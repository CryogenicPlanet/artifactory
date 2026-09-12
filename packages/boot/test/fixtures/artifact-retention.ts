import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Effect, FileSystem, Schema } from "effect";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { artifactRetention } from "../../src/artifact-retention.ts";

const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(
		Schema.fromJsonString(
			Schema.Struct({
				capacity: Schema.optionalKey(Schema.Int),
				required: Schema.optionalKey(Schema.Int),
				preserve: Schema.optionalKey(Schema.Array(Schema.Int)),
				fail_sync: Schema.optionalKey(Schema.Boolean),
				fail_generation_sync: Schema.optionalKey(Schema.Boolean),
			}),
		),
	)(process.argv[3] ?? "{}");
	const fs = yield* FileSystem.FileSystem;
	let directorySyncs = 0;
	const observed = {
		...fs,
		open: (...args: Parameters<typeof fs.open>) => {
			if (args[0].endsWith("/backups")) {
				directorySyncs++;
				if (input.fail_sync) return Effect.die("Injected directory sync failure");
			}
			if (args[0].endsWith("/gen") && input.fail_generation_sync) return Effect.die("Injected generation sync failure");
			return fs.open(...args);
		},
	};
	const result = yield* Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* (yield* artifactRetention(root)).prune(
			input.capacity === undefined
				? { status: "unavailable", reason: "measurement_failed" }
				: { status: "available", capacity_bytes: input.capacity, available_bytes: input.capacity },
			input.required ?? 0,
			input.preserve ?? [],
		);
	}).pipe(
		Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })),
		Effect.provideService(FileSystem.FileSystem, observed),
		Effect.result,
	);
	yield* Console.log(
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
			result._tag === "Success"
				? { success: result.success, directory_syncs: directorySyncs }
				: { failure: result.failure },
		),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
