import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { ChildAttempts, layer as attemptsLayer } from "../../src/child-attempts.ts";
import { KernelBoot } from "../../src/kernel-boot.ts";

const Input = Schema.Struct({
	op: Schema.Literals(["reserve", "crash", "recover", "legacy"]),
	bootId: Schema.NullOr(Schema.String),
	unopened: Schema.optionalKey(Schema.Boolean),
	storedId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const program = Effect.gen(function* () {
	const directory = process.argv[2];
	if (!directory) return yield* Effect.die("Missing disposable directory");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "");
	const execute = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* initializeBootSchema;
		if (input.op === "legacy") {
			yield* sql`ALTER TABLE child_attempts DROP COLUMN boot_id`;
			yield* sql`ALTER TABLE backups DROP COLUMN published_through`;
			yield* sql`ALTER TABLE backups DROP COLUMN generation`;
			yield* sql`DROP TABLE public_paths`;
			yield* sql`DROP INDEX events_type_seq`;
			yield* sql`DROP INDEX events_actor_seq`;
			yield* sql`DROP INDEX events_instance_seq`;
			yield* sql`DROP INDEX events_level_seq`;
			yield* sql`DROP INDEX events_topic_seq`;
			yield* sql`ALTER TABLE events DROP COLUMN type`;
			yield* sql`ALTER TABLE events DROP COLUMN actor`;
			yield* sql`ALTER TABLE events DROP COLUMN instance`;
			yield* sql`ALTER TABLE events DROP COLUMN level`;
			yield* sql`ALTER TABLE events DROP COLUMN topic`;
			yield* sql`DROP TABLE IF EXISTS topic_moves`;
			yield* sql`DROP TABLE IF EXISTS topic_page_moves`;
			yield* sql`DROP TABLE db_restore_requests`;
			yield* sql`ALTER TABLE generations DROP COLUMN backup_id`;
			yield* sql`ALTER TABLE source_changes DROP COLUMN before_directory`;
			yield* sql`ALTER TABLE source_changes DROP COLUMN desired_directory`;
			yield* sql`ALTER TABLE versions DROP COLUMN previous_directory`;
			yield* sql`ALTER TABLE versions DROP COLUMN directory`;
			yield* sql`ALTER TABLE edit_lock DROP COLUMN reset_pin`;
			yield* sql`PRAGMA user_version=11`;
			yield* sql`INSERT INTO child_attempts(id,generation,receipt,opened) VALUES('legacy',1,${`${directory}/attempts/legacy.closed`},1)`;
			return { result: "legacy" };
		}
		return yield* Effect.gen(function* () {
			const attempts = yield* ChildAttempts;
			if (input.op === "reserve" || input.op === "crash") {
				const reserved = yield* attempts.reserve(1);
				// No go handshake or later opened call is needed to durably own an attempted spawn.
				const beforeOpen = yield* sql`SELECT boot_id,opened FROM child_attempts WHERE id=${reserved.id}`;
				if (input.unopened) yield* sql`UPDATE child_attempts SET opened=0 WHERE id=${reserved.id}`;
				if (input.storedId !== undefined)
					yield* sql`UPDATE child_attempts SET boot_id=${input.storedId} WHERE id=${reserved.id}`;
				if (input.op === "crash") {
					yield* Console.log(
						yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ ...reserved, beforeOpen }),
					);
					return yield* Effect.never;
				}
				return { ...reserved, beforeOpen };
			}
			// Skip only test delays; recovery still exhausts all receipt checks before refusing.
			const clock = yield* Clock.Clock;
			const result = yield* attempts.recover.pipe(
				Effect.provideService(Clock.Clock, {
					currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
					currentTimeMillis: clock.currentTimeMillis,
					currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
					currentTimeNanos: clock.currentTimeNanos,
					monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
					monotonicTimeNanos: clock.monotonicTimeNanos,
					sleep: () => Effect.void,
				}),
				Effect.result,
			);
			return {
				result: result._tag,
				error: result._tag === "Failure" ? String(result.failure) : null,
				rows: yield* sql`SELECT id,boot_id,opened,closed FROM child_attempts ORDER BY id`,
				version: yield* sql`PRAGMA user_version`,
			};
		}).pipe(
			Effect.provide(attemptsLayer(directory).pipe(Layer.provide(Layer.succeed(KernelBoot)({ id: input.bootId })))),
		);
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${directory}/boot.db`, disableWAL: true })));
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* execute));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
