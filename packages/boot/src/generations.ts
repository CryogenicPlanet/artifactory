import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Generation = Schema.Struct({
	n: Schema.Int,
	snapshot_dir: Schema.NullOr(Schema.String),
	entry_file: Schema.String,
	status: Schema.Literals(["starting", "live", "failed", "retired"]),
	good: Schema.Literals([0, 1]),
	stderr: Schema.String,
	error: Schema.NullOr(Schema.String),
	started_at: Schema.Int,
	healthy_at: Schema.NullOr(Schema.Int),
	retired_at: Schema.NullOr(Schema.Int),
});
export type Generation = typeof Generation.Type;

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const list = sql`SELECT * FROM generations ORDER BY n DESC`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Generation))),
	);
	return {
		list,
		recover: sql`UPDATE generations SET status = CASE WHEN good = 1 THEN 'retired' ELSE 'failed' END,
			error = CASE WHEN good = 0 THEN 'Boot stopped before generation became healthy' ELSE error END
			WHERE status IN ('starting', 'live')`.pipe(Effect.asVoid),
		appSeeded: sql`SELECT value FROM settings WHERE key = 'app_seeded'`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.Literal("1") })))),
			Effect.map((rows) => rows.length > 0),
		),
		markAppSeeded: sql`INSERT OR IGNORE INTO settings (key, value) VALUES ('app_seeded', '1')`.pipe(Effect.asVoid),
		reserve: Effect.fn("Generations.reserve")(function* (entryFile: string) {
			const now = yield* DateTime.nowAsDate;
			const rows = yield* sql`INSERT INTO generations (entry_file, status, started_at)
				VALUES (${entryFile}, 'starting', ${now.getTime()}) RETURNING *`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Generation))),
			);
			const generation = rows[0];
			if (!generation || !Number.isSafeInteger(generation.n)) return yield* Effect.die("Invalid generation id");
			return generation;
		}),
		setSnapshot: (n: number, directory: string) =>
			sql`UPDATE generations SET snapshot_dir = ${directory} WHERE n = ${n}`.pipe(Effect.asVoid),
		starting: (n: number) => sql`UPDATE generations SET status = 'starting' WHERE n = ${n}`.pipe(Effect.asVoid),
		healthy: Effect.fn("Generations.healthy")(function* (n: number) {
			const now = yield* DateTime.nowAsDate;
			yield* sql`UPDATE generations SET status = 'live', good = 1, healthy_at = ${now.getTime()},
				error = NULL, stderr = '' WHERE n = ${n}`;
		}),
		failed: (n: number, error: string, stderr: string) =>
			sql`UPDATE generations SET status = 'failed', error = ${error}, stderr = ${stderr} WHERE n = ${n}`.pipe(
				Effect.asVoid,
			),
	};
});

/** Durable generation history. Good is a historical tag, never cleared by a failed restart. */
export class Generations extends Context.Service<Generations, Effect.Success<typeof make>>()(
	"comms/boot/Generations",
) {}
export const layer = Layer.effect(Generations, make);
