import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import type { SystemApi } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { readSql, SqlReadInput, SqlReadResult } from "./kernel/sql-read.ts";
import { RequestValidation, layer as bodyLayer } from "./request-schema.ts";

export const sqlGroup = HttpApiGroup.make("sql").add(
	HttpApiEndpoint.post("query", "/api/sql", {
		payload: SqlReadInput,
		query: Schema.Record(Schema.String, Schema.Never),
		success: HttpApiSchema.WithHeaders(SqlReadResult, { "cache-control": Schema.Literal("no-store") }),
	})
		.middleware(RequestValidation)
		.annotate(
			OpenApi.Description,
			"Inspect physical committed app rows with read scope using one SELECT or WITH query. Readonly SQLite connection; no publication cursor. Returns at most 200 rows with truncated, up to 128KiB JSON. SQL up to 16KiB, request up to 64KiB, at most 100 string/finite-number/null parameters. Comments and semicolons are unsupported even inside literals: use parameters. Writes, PRAGMA and other commands return 501. BLOBs and integers outside JSON's safe range must be cast to text. Queries are synchronous. Boot terminates a nonresponsive whole child through its keeper; this can interrupt other requests and is not statement rollback or a memory limit.",
		),
);
export const sqlHandlers = (api: typeof SystemApi) =>
	HttpApiBuilder.group(api, "sql", (handlers) =>
		handlers.handle("query", ({ payload }) =>
			failure(
				Effect.gen(function* () {
					yield* identity("read");
					const result = yield* readSql(payload);
					if (result === null) return yield* new KernelError({ code: "sql_unsupported" });
					return HttpApiSchema.withHeaders({ body: result, headers: { "cache-control": "no-store" as const } });
				}),
			),
		),
	).pipe(Layer.provide(bodyLayer(65536)));
