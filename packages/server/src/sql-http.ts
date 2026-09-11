import { errorSchemas } from "./error-contract.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import type { SystemApi } from "./conversation.ts";
import { refusal, identity } from "./conversation-request.ts";
import { Publication } from "./kernel/publication.ts";
import { readSql, queryShape, SqlInput } from "./kernel/sql-read.ts";
import { SqlRows } from "./kernel/sql-result.ts";
import { SqlWriteResult } from "./kernel/sql-write.ts";
import { RequestValidation, layer as bodyLayer } from "./request-schema.ts";

export const sqlGroup = HttpApiGroup.make("sql").add(
	HttpApiEndpoint.post("query", "/api/sql", {
		error: errorSchemas,
		payload: SqlInput,
		query: Schema.Record(Schema.String, Schema.Never),
		success: HttpApiSchema.WithHeaders(Schema.Union([SqlWriteResult, SqlRows]), {
			"cache-control": Schema.Literal("no-store"),
		}),
	})
		.middleware(RequestValidation)
		.annotate(
			OpenApi.Description,
			"Inspect physical committed app rows with read scope using one SELECT or WITH query. Readonly SQLite connection; no publication cursor. Returns at most 200 rows with truncated, up to 128KiB JSON. SQL up to 16KiB, request up to 64KiB, at most 100 string/finite-number/null parameters. Comments and semicolons are unsupported even inside literals: use parameters. Writes require fs scope and return rows, truncated, changes (including trigger changes), and sql.write seq after publication. An unchanged Idempotency-Key replays the first write result for 30 days. One INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP or WITH write is supported. Transaction control and ROLLBACK clauses, PRAGMA, attachments, triggers, temporary objects and recovery tables are unavailable. Prefer domain routes and extension helpers. Raw SQL bypasses domain validation and event/projection maintenance; callers must complete those repairs, including publishing page-policy changes before relying on them. BLOBs and integers outside JSON's safe range must be cast to text. Queries are synchronous. Boot terminates a nonresponsive or transaction-uncertain whole child through its keeper; this can interrupt other requests and is not statement rollback or a memory limit.",
		),
);
export const sqlHandlers = (api: typeof SystemApi) =>
	HttpApiBuilder.group(api, "sql", (handlers) =>
		handlers.handle("query", ({ payload, request }) =>
			refusal(
				Effect.gen(function* () {
					const read = yield* queryShape(payload);
					const who = yield* identity(read ? "read" : "fs");
					const result = read
						? yield* readSql(payload)
						: yield* (yield* Publication).writeSql(who, payload, request.headers["idempotency-key"]);
					return HttpApiSchema.withHeaders({ body: result, headers: { "cache-control": "no-store" as const } });
				}),
			),
		),
	).pipe(Layer.provide(bodyLayer(65536)));
