import { Crypto, Effect, Ref, Schema, Stream, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { HealthProbe, layer as probeLayer } from "./health-probe.ts";
import { Message } from "./messages.ts";

class RolledBack extends Schema.TaggedError<RolledBack>()("HealthRolledBack", {}) {}

/** Runs the assembled HTTP handlers under one transaction and confirms rollback before aborting the range. */
export const probeHealth = <E, R>(
	dispatch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		HttpServerRequest.HttpServerRequest | Scope.Scope | R
	>,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const boot = yield* BootChannel;
		const probe = yield* HealthProbe;
		const marker = `probe-${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
		const topic = `health/${marker}`;
		const bodyMarker = `message-${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
		const call = (method: string, path: string, body?: string) =>
			Effect.gen(function* () {
				const response = yield* dispatch.pipe(
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(
							new Request(`http://127.0.0.1${path}`, {
								method,
								headers: {
									"content-type": "application/json",
									"x-comms-agent": "boot",
									"x-comms-instance": marker,
									"x-comms-request-id": marker,
									"x-comms-auth-kind": "human",
									"x-comms-scopes": "read,write",
									"idempotency-key": marker,
								},
								...(body === undefined ? {} : { body }),
							}),
						),
					),
				);
				if (response.status !== 200) return yield* new KernelError({ code: "health_route_failed" });
				let bytes = 0;
				const chunks = yield* HttpServerResponse.toClientResponse(response).stream.pipe(
					Stream.tap((chunk) =>
						Effect.gen(function* () {
							bytes += chunk.byteLength;
							if (bytes > 262144) return yield* new KernelError({ code: "health_response_too_large" });
						}),
					),
					Stream.runCollect,
					Effect.timeout("2 seconds"),
				);
				return Buffer.concat(chunks).toString("utf8");
			});
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					const created = yield* call(
						"POST",
						"/api/messages",
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Struct({ topic: Schema.String, body: Schema.String })),
						)({ topic, body: bodyMarker }),
					);
					const message = yield* Schema.decodeEffect(Schema.fromJsonString(Message))(created);
					if (message.topic !== topic || message.body !== bodyMarker)
						return yield* new KernelError({ code: "health_create_invalid" });
					const read = yield* call("GET", `/api/messages?topic=${topic}&since=0&wait=0`);
					const listed = yield* Schema.decodeEffect(
						Schema.fromJsonString(Schema.Struct({ items: Schema.Array(Message) })),
					)(read);
					if (
						!listed.items.some((item) => item.id === message.id && item.seq === message.seq && item.body === bodyMarker)
					)
						return yield* new KernelError({ code: "health_read_invalid" });
					const digest = yield* call("GET", `/api/ctx?topic=${topic}&since=0&budget=4000`);
					if (!digest.includes(bodyMarker) || !digest.includes(topic) || !digest.includes(`#${message.seq}`))
						return yield* new KernelError({ code: "health_context_invalid" });
					return yield* new RolledBack();
				}),
			)
			.pipe(Effect.result);
		// Typed failure arrives only after the outer rollback succeeds. A rollback defect must leave evidence pending.
		const reservation = yield* Ref.get(probe.reservation);
		if (reservation) {
			yield* boot.reserve(reservation.transaction, reservation.count);
			yield* boot.abort(reservation.transaction);
		}
		if (result._tag !== "Failure" || !Schema.is(RolledBack)(result.failure))
			return yield* new KernelError({ code: "health_failed" });
		return { status: "ok" };
	}).pipe(Effect.provide(probeLayer));
