import { respond, subscriptionErrors } from "./response.ts";
import { Effect, Schema, Semaphore } from "effect";
import type { Api, BackgroundContext } from "../../kernel/extension-api.ts";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Input, created, SubscriptionError, validate } from "./contract.ts";
import { makeStore } from "./store.ts";
import { runDelivery } from "./delivery.ts";
import { on } from "@comms/storage/dialect";
import { SqlClient } from "effect/unstable/sql";

const Receipt = Schema.Struct({
	id: Schema.String,
	filter: Input.fields.filter,
	deliver: Input.fields.deliver,
	created_at: Schema.Int,
	since: Schema.Int,
});
export const definition = HttpApi.make("subscriptions").add(
	HttpApiGroup.make("subscriptions").add(
		HttpApiEndpoint.post("create", "/api/subscriptions", {
			error: subscriptionErrors,
			payload: Input,
			success: Receipt,
		}).annotate(
			OpenApi.Description,
			"Persist a webhook subscription from the current published cursor. Requires read and write. Supply Idempotency-Key for retries.",
		),
		HttpApiEndpoint.get("list", "/api/subscriptions", {
			error: subscriptionErrors,
			success: Schema.Struct({
				items: Schema.Array(
					Schema.Struct({
						...Receipt.fields,
						cursor: Schema.Int,
						attempts: Schema.Int,
						next_attempt: Schema.Int,
						last_error: Schema.NullOr(Schema.String),
					}),
				),
			}),
		}).annotate(
			OpenApi.Description,
			"List this instance’s active webhook subscriptions and retry status. Humans can list all subscriptions.",
		),
		HttpApiEndpoint.delete("remove", "/api/subscriptions/:id", {
			error: subscriptionErrors,
			params: { id: Schema.String },
		}).annotate(
			OpenApi.Description,
			"Stop a webhook subscription owned by this instance. Humans can stop any subscription; deletion is idempotent.",
		),
	),
);

export default (api: Api) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* api.migrate(
			"webhook_subscriptions",
			on(sql, {
				sqlite: () => `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
 id TEXT PRIMARY KEY, instance TEXT NOT NULL, agent TEXT NOT NULL, human INTEGER NOT NULL,
 input TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL,
 start_seq INTEGER NOT NULL, created_seq INTEGER NOT NULL, deleted_seq INTEGER,
 cursor INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 UNIQUE(instance,idempotency_key))`,
				pg: () => `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
 id TEXT PRIMARY KEY, instance TEXT NOT NULL, agent TEXT NOT NULL, human INTEGER NOT NULL,
 input TEXT NOT NULL, idempotency_key TEXT, created_at BIGINT NOT NULL,
 start_seq BIGINT NOT NULL, created_seq BIGINT NOT NULL, deleted_seq BIGINT,
 cursor BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt BIGINT NOT NULL DEFAULT 0, last_error TEXT,
 UNIQUE(instance,idempotency_key))`,
				mysql: () => `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
 id VARCHAR(64) PRIMARY KEY, instance LONGTEXT NOT NULL, agent LONGTEXT NOT NULL, human INTEGER NOT NULL,
 input LONGTEXT NOT NULL, idempotency_key LONGTEXT, created_at BIGINT NOT NULL,
 start_seq BIGINT NOT NULL, created_seq BIGINT NOT NULL, deleted_seq BIGINT,
 \`cursor\` BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt BIGINT NOT NULL DEFAULT 0, last_error LONGTEXT,
 instance_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(instance,256))) STORED,
 idempotency_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(idempotency_key,256))) STORED,
 UNIQUE(instance_hash,idempotency_hash)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
			}),
			{ protect: true },
		);
		const gate = yield* Semaphore.make(1);
		api.mount(
			definition,
			HttpApiBuilder.group(definition, "subscriptions", (handlers) =>
				handlers
					.handle("create", ({ payload }) =>
						respond(
							Effect.gen(function* () {
								const ctx = yield* api.context("write");
								yield* api.context("read");
								const request = yield* HttpServerRequest.HttpServerRequest;
								const input = yield* Effect.try({
									try: () => validate(payload),
									catch: () => new SubscriptionError({ code: "input_invalid" }),
								});
								const key = request.headers["idempotency-key"] ?? null;
								if (
									key !== null &&
									(key.length < 1 ||
										key.length > 200 ||
										Array.from(key).some(
											(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
										))
								)
									return yield* new SubscriptionError({ code: "input_invalid" });
								return yield* gate.withPermit(makeStore(ctx).create(ctx, input, key));
							}),
						),
					)
					.handle("list", () =>
						respond(
							Effect.gen(function* () {
								const ctx = yield* api.context("read");
								return yield* gate.withPermit(makeStore(ctx).visible).pipe(
									Effect.map((rows) => ({
										items: rows
											.filter((row) => ctx.kind === "human" || row.instance === ctx.instance)
											.map((row) => ({
												...created(row),
												cursor: row.cursor,
												attempts: row.attempts,
												next_attempt: row.next_attempt,
												last_error: row.last_error,
											})),
									})),
								);
							}),
						),
					)
					.handle("remove", ({ params }) =>
						respond(
							Effect.gen(function* () {
								const ctx = yield* api.context("write");
								yield* gate.withPermit(makeStore(ctx).remove(ctx, params.id));
								return HttpServerResponse.empty({ status: 204 });
							}),
						),
					),
			),
		);
		api.on("start", (event: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) =>
			event.reason === "live"
				? runDelivery(ctx, makeStore(ctx), gate, api.effects).pipe(Effect.forkScoped, Effect.asVoid)
				: Effect.void,
		);
	});
