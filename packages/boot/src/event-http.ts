// oxlint-disable-next-line effecttsgo/node-builtin-import -- Constant-time comparison is not exposed by Effect Crypto.
import { timingSafeEqual } from "node:crypto";
import { DateTime, Effect, Ref, Schema, type Semaphore, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { VerifiedIdentity } from "./enrollment.ts";
import { publicEventResponse } from "./public-event-http.ts";
import { Batch, type Events, EventError } from "./events.ts";

export interface Attempt {
	readonly secret: string;
	readonly epoch: string;
	readonly host: string;
	readonly generation: number;
	readonly state: "starting" | "accepted" | "live" | "frozen";
}
export type EventStore = Ref.Ref<Events["Service"] | null>;
const reserveBody = Schema.Struct({ transaction: Schema.String, count: Schema.Int });
const abortBody = Schema.Struct({ transaction: Schema.String });
const failure = (code: string, status: number) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message: "Event operation unavailable.",
				hint:
					code === "scope_required"
						? "Re-enroll and ask the human to grant read scope."
						: "Retry infrastructure failures; inspect authenticated boot status.",
				retriable: status === 503,
			},
		},
		{ status },
	);
const readBody = <S extends Schema.Constraint>(request: HttpServerRequest.HttpServerRequest, schema: S) =>
	Effect.gen(function* () {
		let bytes = 0;
		const chunks = yield* request.stream.pipe(
			Stream.tap((chunk) =>
				Effect.gen(function* () {
					bytes += chunk.byteLength;
					if (bytes > 1_048_576) return yield* new EventError({ code: "body_too_large" });
				}),
			),
			Stream.runCollect,
			Effect.timeout("2 seconds"),
		);
		return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(Buffer.concat(chunks).toString("utf8"));
	});
export const eventRoute = (
	store: EventStore,
	attempts: Ref.Ref<readonly Attempt[]>,
	identity: VerifiedIdentity | null,
	gate: Semaphore.Semaphore,
	revalidate: Effect.Effect<boolean> = Effect.succeed(true),
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const internal = ["/_boot/seq", "/_boot/seq/reserve", "/_boot/seq/abort", "/_boot/events/append"].includes(
			url.pathname,
		);
		const query = ["/_boot/events", "/api/events", "/_boot/stream", "/api/stream"].includes(url.pathname);
		if (!internal && !query) return null;
		let attempt: Attempt | null = null;
		if (internal || request.headers["x-boot-secret"] !== undefined) {
			const supplied = Buffer.from(request.headers["x-boot-secret"] ?? "");
			attempt =
				(yield* Ref.get(attempts)).find((item) => {
					const value = Buffer.from(item.secret);
					return value.length === supplied.length && timingSafeEqual(value, supplied);
				}) ?? null;
			const expected = Buffer.from(attempt?.secret ?? "");
			if (
				!attempt ||
				supplied.length !== expected.length ||
				!timingSafeEqual(supplied, expected) ||
				request.headers.host !== attempt.host ||
				Object.keys(request.headers).some((key) => key.startsWith("x-forwarded-") || key === "forwarded")
			)
				return failure("child_forbidden", 403);
			if (attempt.state === "starting" && url.pathname === "/_boot/events/append")
				return failure("child_not_live", 409);
		} else if (!identity) return null;
		else if (!identity.scopes.includes("read")) return failure("scope_required", 403);
		const bodyText = request.method === "POST" ? yield* readBody(request, Schema.Unknown).pipe(Effect.result) : null;
		const service = yield* Ref.get(store);
		if (!service) return failure("events_unavailable", 503);
		if (url.pathname === "/_boot/seq" && request.method === "GET") {
			const params = url.searchParams;
			const after = Number(params.get("since") ?? "0");
			const wait = Number(params.get("wait") ?? "0");
			if (
				[...params.keys()].some((key) => !["since", "wait"].includes(key) || params.getAll(key).length !== 1) ||
				![...params.values()].every((value) => /^[0-9]+$/.test(value)) ||
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isSafeInteger(wait) ||
				wait < 0 ||
				wait > 60
			)
				return failure("query_invalid", 400);
			return yield* Effect.gen(function* () {
				if (wait > 0) yield* service.changed(after).pipe(Effect.timeoutOption(wait * 1000));
				// Waiting holds no operation permit. Recheck attempt ownership before revealing the result.
				return yield* gate
					.withPermit(
						Effect.gen(function* () {
							if (!attempt || !(yield* Ref.get(attempts)).some((item) => item.epoch === attempt.epoch))
								return failure("stale_attempt", 403);
							return HttpServerResponse.jsonUnsafe({ published_through: (yield* service.state).published_through });
						}),
					)
					.pipe(Effect.timeout("2 seconds"));
			}).pipe(Effect.catchCause(() => Effect.succeed(failure("events_unavailable", 503))));
		}
		if (query) {
			if (request.method !== "GET") return failure("method_invalid", 405);
			const read: typeof service.query = (input) =>
				Effect.gen(function* () {
					if (identity && identity.expiresAt <= (yield* DateTime.nowAsDate).getTime())
						return yield* new EventError({ code: "credential_expired" });
					const page = yield* gate.withPermit(
						Effect.gen(function* () {
							if (attempt && !(yield* Ref.get(attempts)).some((item) => item.epoch === attempt.epoch))
								return yield* new EventError({ code: "stale_attempt" });
							return yield* service.query(input);
						}),
					);
					if (identity && page.items.length > 0 && !(yield* revalidate))
						return yield* new EventError({ code: "credential_invalid" });
					return page;
				}).pipe(
					Effect.timeoutOrElse({
						duration: "2 seconds",
						orElse: () => Effect.fail(new EventError({ code: "events_unavailable" })),
					}),
				);
			return yield* publicEventResponse(request, identity, read, service.changed).pipe(
				Effect.catchTag("EventError", (error) =>
					Effect.succeed(
						failure(
							error.code,
							error.code.startsWith("credential_")
								? 401
								: error.code === "stale_attempt"
									? 403
									: error.code === "events_unavailable"
										? 503
										: 400,
						),
					),
				),
				Effect.catchCause(() => Effect.succeed(failure("events_unavailable", 503))),
			);
		}
		return yield* gate
			.withPermit(
				Effect.gen(function* () {
					if (attempt) {
						const admitted = (yield* Ref.get(attempts)).find((item) => item.epoch === attempt?.epoch);
						if (!admitted) return failure("stale_attempt", 403);
						if (admitted.state === "starting" && url.pathname === "/_boot/events/append")
							return failure("child_not_live", 409);
					}
					if (bodyText && bodyText._tag === "Failure") return failure("body_invalid", 400);
					const bodyValue = bodyText ? bodyText.success : undefined;

					if (!attempt) return failure("child_forbidden", 403);
					if (request.method !== "POST") return failure("method_invalid", 405);
					if (url.pathname === "/_boot/seq/reserve") {
						const body = yield* Schema.decodeUnknownEffect(reserveBody)(bodyValue);
						return HttpServerResponse.jsonUnsafe(yield* service.reserve(body.transaction, body.count, attempt.epoch));
					}
					if (url.pathname === "/_boot/seq/abort") {
						const body = yield* Schema.decodeUnknownEffect(abortBody)(bodyValue);
						yield* service.abort(body.transaction, attempt.epoch);
						return HttpServerResponse.empty({ status: 204 });
					}
					if (url.pathname === "/_boot/events/append") {
						const body = yield* Schema.decodeUnknownEffect(Batch)(bodyValue);
						if (
							(yield* service.state).pending_id === body.transaction &&
							body.events.some((event) => event.generation !== attempt.generation)
						)
							return failure("generation_invalid", 409);
						return HttpServerResponse.jsonUnsafe(yield* service.append(body, attempt.epoch));
					}
					return failure("method_invalid", 405);
				}).pipe(Effect.timeout("2 seconds")),
			)
			.pipe(
				Effect.catchTags({
					EventError: (error) => Effect.succeed(failure(error.code, 409)),
					SchemaError: () => Effect.succeed(failure("body_invalid", 400)),
				}),
				Effect.catchCause(() => Effect.succeed(failure("events_unavailable", 503))),
			);
	});
