import { Cause, Effect, Schema, Semaphore, Stream } from "effect";
import type { Api } from "../../kernel/extension-api.ts";
import { FetchHttpClient, HttpClient, type HttpServerRequest } from "effect/unstable/http";
import { BootChannel } from "../../kernel/boot-channel.ts";
import { Lifecycle } from "../../kernel/lifecycle.ts";
import { Input, created, SubscriptionError, validate } from "./contract.ts";
import { makeStore } from "./store.ts";
import { runDelivery } from "./delivery.ts";

const respond = <E, R>(effect: Effect.Effect<Response, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
			const reason = cause.reasons.find(
				(reason) => reason._tag === "Fail" && Schema.is(SubscriptionError)(reason.error),
			);
			const own = reason?._tag === "Fail" && Schema.is(SubscriptionError)(reason.error) ? reason.error : null;
			const status = own?.status ?? 503,
				code = own?.code ?? "subscription_unavailable";
			return Effect.succeed(
				Response.json(
					{
						error: {
							code,
							message: "Subscription request failed.",
							hint:
								status === 503
									? "Retry with the same Idempotency-Key."
									: "Check /api and the subscription documentation.",
							retriable: status === 503,
						},
					},
					{ status },
				),
			);
		}),
	);
const body = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		let length = 0;
		const chunks = yield* request.stream.pipe(
			Stream.tap((chunk) => {
				length += chunk.byteLength;
				return length > 8192 ? Effect.fail(new SubscriptionError({ code: "input_invalid", status: 400 })) : Effect.void;
			}),
			Stream.runCollect,
			Effect.timeout("2 seconds"),
		);
		return yield* Schema.decodeEffect(Schema.fromJsonString(Input))(Buffer.concat(chunks).toString("utf8"), {
			onExcessProperty: "error",
		});
	}).pipe(
		Effect.flatMap((input) => Effect.try(() => validate(input))),
		Effect.mapError(() => new SubscriptionError({ code: "input_invalid", status: 400 })),
	);

/** Bundled reference: intentionally captures trusted kernel services, never credentials. */
export default (api: Api) =>
	Effect.gen(function* () {
		const boot = yield* BootChannel,
			lifecycle = yield* Lifecycle;
		const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
		const store = yield* makeStore,
			gate = yield* Semaphore.make(1);
		api.route("POST", "/api/subscriptions", {
			description:
				"Persist a webhook delivery subscription from the current published cursor. Requires read and write. Supply Idempotency-Key for retries.",
			scope: "write",
			handler: (request, ctx) =>
				respond(
					Effect.gen(function* () {
						if (!(request.headers["x-comms-scopes"] ?? "").split(",").includes("read"))
							return yield* new SubscriptionError({ code: "scope_required", status: 403 });
						const input = yield* body(request),
							key = request.headers["idempotency-key"] ?? null;
						if (
							key !== null &&
							(key.length < 1 ||
								key.length > 200 ||
								key.split("").some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
						)
							return yield* new SubscriptionError({ code: "input_invalid", status: 400 });
						return yield* gate
							.withPermit(store.create(ctx, input, key))
							.pipe(Effect.map((result) => Response.json(result)));
					}),
				),
		});
		api.route("GET", "/api/subscriptions", {
			description:
				"List this instance’s active webhook subscriptions and delivery retry status. Humans can list all subscriptions.",
			scope: "read",
			handler: (_request, ctx) =>
				respond(
					gate.withPermit(store.visible).pipe(
						Effect.map((rows) =>
							Response.json({
								items: rows
									.filter((row) => ctx.kind === "human" || row.instance === ctx.instance)
									.map((row) => ({
										...created(row),
										cursor: row.cursor,
										attempts: row.attempts,
										next_attempt: row.next_attempt,
										last_error: row.last_error,
									})),
							}),
						),
					),
				),
		});
		api.route("DELETE", "/api/subscriptions/:id", {
			description:
				"Stop a webhook subscription owned by this instance. Humans can stop any subscription; deletion is idempotent.",
			scope: "write",
			handler: (_request, ctx) =>
				respond(
					gate.withPermit(store.remove(ctx, ctx.params.id ?? "")).pipe(Effect.as(new Response(null, { status: 204 }))),
				),
		});
		api.on("start", () =>
			runDelivery(store, gate).pipe(
				Effect.provideService(BootChannel, boot),
				Effect.provideService(Lifecycle, lifecycle),
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.forkScoped,
				Effect.asVoid,
			),
		);
	});
