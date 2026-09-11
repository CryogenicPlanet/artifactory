import { Effect, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { readSql, SqlReadInput, SqlReadResult } from "./kernel/sql-read.ts";

export const sqlGroup = HttpApiGroup.make("sql").add(
	HttpApiEndpoint.post("query", "/api/sql", { payload: SqlReadInput, success: SqlReadResult }).annotate(
		OpenApi.Description,
		"Inspect physical committed app rows with read scope using one SELECT or WITH query. Readonly SQLite connection; no publication cursor. Returns at most200 rows with truncated, up to128KiB JSON. SQL up to16KiB, request up to64KiB, at most100 string/finite-number/null parameters. Comments and semicolons are unsupported even inside literals: use parameters. Writes, PRAGMA and other commands return501. BLOBs and integers outside JSON's safe range must be cast to text. Queries are synchronous; these limits do not bound computation or intermediate allocation.",
	),
);
export const sqlHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "sql", (handlers) =>
		handlers.handleRaw("query", () =>
			failure(
				Effect.gen(function* () {
					yield* identity("read");
					const request = yield* HttpServerRequest.HttpServerRequest;
					if (new URL(request.url, "http://localhost").search !== "")
						return yield* new KernelError({ code: "query_invalid" });
					let bytes = 0;
					const chunks = yield* request.stream.pipe(
						Stream.tap((chunk) =>
							Effect.gen(function* () {
								bytes += chunk.byteLength;
								if (bytes > 65536) return yield* new KernelError({ code: "input_invalid" });
							}),
						),
						Stream.runCollect,
						Effect.timeout("5 seconds"),
					);
					const input = yield* Schema.decodeEffect(Schema.fromJsonString(SqlReadInput))(
						Buffer.concat(chunks).toString("utf8"),
					).pipe(Effect.mapError(() => new KernelError({ code: "input_invalid" })));
					const result = yield* readSql(input);
					return result === null
						? HttpServerResponse.jsonUnsafe(
								{
									error: {
										code: "sql_unsupported",
										message: "Only a single SELECT or WITH read query is supported.",
										hint: "Remove SQL comments and semicolons; bind literal text as parameters. SQL writes are not implemented.",
										retriable: false,
									},
								},
								{ status: 501, headers: { "cache-control": "no-store" } },
							)
						: HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
				}),
			),
		),
	);
