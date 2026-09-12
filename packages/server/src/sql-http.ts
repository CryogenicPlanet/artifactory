import { errorSchemas } from "@comms/protocol/errors";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import type { SystemApi } from "./conversation.ts";
import { refusal, identity } from "./conversation-request.ts";
import { Publication } from "./kernel/publication.ts";
import { makeSqlReader } from "./kernel/sql-read.ts";
import { SqlInput, sqlInput } from "./kernel/sql-input.ts";
import { SqlReadRows } from "./kernel/sql-read-wire.ts";
import { SqlWriteResult } from "./kernel/sql-write.ts";
import { RequestValidation } from "@comms/protocol/request-validation";
import { layer as bodyLayer } from "./request-schema.ts";

export const sqlGroup = HttpApiGroup.make("sql").add(
	HttpApiEndpoint.post("query", "/api/sql", {
		error: errorSchemas,
		payload: SqlInput,
		query: Schema.Record(Schema.String, Schema.Never),
		success: HttpApiSchema.WithHeaders(Schema.Union([SqlWriteResult, SqlReadRows]), {
			"cache-control": Schema.Literal("no-store"),
		}),
	})
		.middleware(RequestValidation)
		.annotate(
			OpenApi.Description,
			"Inspect physical committed app rows with read scope using one SELECT or WITH query. Readonly SQLite connection or registered remote connection in a read-only transaction; no publication cursor. Remote transactions prevent database writes, not server-function side effects; this is not an adversarial SQL sandbox. Read results include dialect (sqlite, pg or mysql). Parameters use ? on SQLite/MySQL and $1, $2 on PostgreSQL. Remote WITH statements must be read-only; ambiguous WITH writes are refused. Returns at most 200 rows with truncated, up to 128KiB JSON. SQL up to 16KiB, request up to 64KiB, at most 100 string/finite-number/null parameters. Comments and semicolons are unsupported even inside literals: use parameters. Raw writes currently support SQLite only. They require fs scope and return rows, truncated, changes (including trigger changes), and sql.write seq after publication. An unchanged Idempotency-Key replays the first write result for 30 days. One INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP or WITH write is supported. Transaction control and ROLLBACK clauses, PRAGMA, attachments, triggers, temporary objects and recovery tables are unavailable. Prefer domain routes and extension helpers. Raw SQL bypasses domain validation and event/projection maintenance; callers must complete those repairs, including publishing page-policy changes before relying on them. BLOBs and integers outside JSON's safe range must be cast to text. Reads run in at most two isolated readonly processes with a three-second total budget including queueing, startup, compilation and execution. Timeout returns 408 sql_query_timeout after the local reader process is reaped; disconnect also closes that process. Remote execution can outlive a disconnected socket; the attempt guardian separately retains its registered sessions for generation closure checks. Reads do not block the serving event loop. Writes remain synchronous: boot terminates a nonresponsive or transaction-uncertain whole child through its keeper; that can interrupt other requests and is not statement rollback. Result caps are not a memory limit.",
		),
);
export const sqlHandlers = (api: typeof SystemApi) =>
	HttpApiBuilder.group(api, "sql", (handlers) =>
		Effect.gen(function* () {
			const inspectSql = yield* makeSqlReader;
			return handlers.handle("query", ({ payload, request }) =>
				refusal(
					Effect.gen(function* () {
						yield* sqlInput(payload);
						const permission = yield* identity("read").pipe(Effect.result);
						if (permission._tag === "Failure") {
							if (/^SELECT\b/i.test(payload.sql.trim())) return yield* permission.failure;
							// WITH needs compilation to distinguish reads from fs-authorized writes.
							if (/^WITH\b/i.test(payload.sql.trim())) yield* identity("fs");
						}
						// Obvious writes and their durable replays must not queue behind readonly work.
						const inspected = /^(SELECT|WITH)\b/i.test(payload.sql.trim())
							? yield* inspectSql(payload, permission._tag === "Success")
							: { kind: "write" as const };
						const result =
							inspected.kind === "read"
								? inspected.result
								: yield* (yield* Publication).writeSql(
										yield* identity("fs"),
										payload,
										request.headers["idempotency-key"],
									);
						return HttpApiSchema.withHeaders({ body: result, headers: { "cache-control": "no-store" as const } });
					}),
				),
			);
		}),
	).pipe(Layer.provide(bodyLayer(65536)));
