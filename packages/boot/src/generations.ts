import { distinctFrom, on } from "@comms/storage/dialect";
import { lockBootWrite } from "./boot-write-lock.ts";
import { decodeRows } from "./decode-rows.ts";
import type { RehearsalReport } from "./rehearsal-report.ts";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Events } from "./events.ts";
import { SqlClient, type Statement } from "effect/unstable/sql";

export const Generation = Schema.Struct({
	n: Schema.Int,
	snapshot_dir: Schema.NullOr(Schema.String),
	backup_id: Schema.NullOr(Schema.String),
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
	const events = yield* Events;
	const record = (
		n: number,
		status: "starting" | "live" | "failed" | "retired" | "rehearsed",
		payload: Schema.Json = {},
	) =>
		DateTime.nowAsDate.pipe(
			Effect.flatMap((now) =>
				events.writeBoot({
					at: now.getTime(),
					type: `generation.${status}`,
					level: status === "failed" ? "error" : "info",
					actor: "boot",
					instance: null,
					generation: n,
					request_id: null,
					topic: null,
					message_id: null,
					payload,
				}),
			),
		);
	const transition = (
		n: number,
		changes: Statement.Fragment,
		condition: Statement.Fragment,
		status: "starting" | "live" | "failed" | "retired",
		payload: Schema.Json = {},
	) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* lockBootWrite(sql);
				const rows = yield* on(sql, {
					sqlite: () => sql`UPDATE generations SET ${changes} WHERE n=${n} AND ${condition} RETURNING n`,
					pg: () => sql`UPDATE generations SET ${changes} WHERE n=${n} AND ${condition} RETURNING n`,
					mysql: () =>
						Effect.gen(function* () {
							const matched = yield* sql`SELECT n FROM generations WHERE n=${n} AND ${condition} FOR UPDATE`;
							if (matched.length) yield* sql`UPDATE generations SET ${changes} WHERE n=${n}`;
							return matched;
						}),
				}).pipe(decodeRows(Schema.Struct({ n: Schema.Int })));
				for (const row of rows) yield* record(row.n, status, payload);
			}),
		);
	const list = sql`SELECT * FROM generations ORDER BY n DESC`.pipe(decodeRows(Generation));
	return {
		list,
		recover: sql.withTransaction(
			Effect.gen(function* () {
				yield* lockBootWrite(sql);
				const rows = yield* list;
				for (const row of rows) {
					if (row.status !== "starting" && row.status !== "live") continue;
					const status = row.good ? "retired" : "failed";
					yield* sql`UPDATE generations SET status=${status}, error=${row.good ? row.error : "Boot stopped before generation became healthy"} WHERE n=${row.n}`;
					yield* record(row.n, status);
				}
			}),
		),
		appSeeded: sql`SELECT value FROM settings WHERE ${sql("key")} = 'app_seeded'`.pipe(
			decodeRows(Schema.Struct({ value: Schema.Literal("1") })),
			Effect.map((rows) => rows.length > 0),
		),
		markAppSeeded:
			sql`INSERT INTO settings (${sql("key")},value) VALUES ('app_seeded','1') ${on(sql, { sqlite: () => sql`ON CONFLICT(${sql("key")}) DO NOTHING`, pg: () => sql`ON CONFLICT(${sql("key")}) DO NOTHING`, mysql: () => sql`ON DUPLICATE KEY UPDATE ${sql("key")}=${sql("key")}` })}`.pipe(
				Effect.asVoid,
			),
		reserve: (entryFile: string) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* lockBootWrite(sql);
					const now = yield* DateTime.nowAsDate;
					const insert = sql`INSERT INTO generations (entry_file,status,started_at) VALUES (${entryFile},'starting',${now.getTime()})`;
					const rows = yield* on(sql, {
						sqlite: () => sql`${insert} RETURNING *`,
						pg: () => sql`${insert} RETURNING *`,
						mysql: () => insert.pipe(Effect.andThen(sql`SELECT * FROM generations WHERE n=LAST_INSERT_ID()`)),
					}).pipe(decodeRows(Generation));
					const generation = rows[0];
					if (!generation || !Number.isSafeInteger(generation.n)) return yield* Effect.die("Invalid generation id");
					yield* record(generation.n, "starting");
					return generation;
				}),
			),
		setSnapshot: (n: number, directory: string) =>
			sql`UPDATE generations SET snapshot_dir = ${directory} WHERE n = ${n}`.pipe(Effect.asVoid),
		starting: (n: number) => transition(n, sql`status='starting'`, sql`status<>'starting'`, "starting"),
		retired: (n: number) =>
			DateTime.nowAsDate.pipe(
				Effect.flatMap((now) =>
					transition(n, sql`status='retired',retired_at=${now.getTime()}`, sql`status='live'`, "retired"),
				),
			),
		rehearsed: (n: number, report: RehearsalReport) => sql.withTransaction(record(n, "rehearsed", report)),
		healthy: (n: number) =>
			Effect.gen(function* () {
				const now = yield* DateTime.nowAsDate;
				yield* transition(
					n,
					sql`status='live',good=1,healthy_at=${now.getTime()},error=NULL,stderr=''`,
					sql`status<>'live'`,
					"live",
				);
			}),
		failed: (n: number, error: string, stderr: string, attempts?: number) =>
			transition(
				n,
				sql`status='failed',error=${error},stderr=${stderr}`,
				sql`(status<>'failed' OR ${distinctFrom(sql, sql`error`, error)} OR stderr<>${stderr})`,
				"failed",
				attempts === 3 ? { reason: "startup_failures", attempts } : {},
			),
	};
});

/** Durable generation history. Good is a historical tag, never cleared by a failed restart. */
export class Generations extends Context.Service<Generations, Effect.Success<typeof make>>()(
	"comms/boot/Generations",
) {}
export const layer = Layer.effect(Generations, make);
