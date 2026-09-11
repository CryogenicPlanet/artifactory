import { Effect, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { SourceRejected } from "./source-schema.ts";
import { authenticate, body } from "./auth-http.ts";
import type { TopicMove } from "./topic-move.ts";
import { TopicMoveError } from "./topic-move-schema.ts";

export type TopicMoveStore = Ref.Ref<TopicMove | null>;
const failure = (code: string, status: number) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message: "Topic move refused.",
				hint: "Retry unavailable operations; inspect /_boot/status if recovery is needed.",
				retriable: status === 503,
			},
		},
		{ status, headers: { "cache-control": "no-store" } },
	);
export const topicMoveRoute = (store: TopicMoveStore, auth: Auth["Service"]) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		if (!url.pathname.startsWith("/api/topics/") || !url.pathname.endsWith("/move")) return null;
		if (request.method !== "POST") return null;
		if (url.search) return failure("unsupported_query", 400);
		const key = request.headers["idempotency-key"];
		if (key !== undefined && !/^[\x20-\x7e]{1,128}$/.test(key)) return failure("idempotency_key_invalid", 400);
		const service = yield* Ref.get(store);
		if (!service) return failure("topic_move_unavailable", 503);
		return yield* Effect.gen(function* () {
			const from = yield* Effect.try({
				try: () => decodeURIComponent(url.pathname.slice("/api/topics/".length, -"/move".length)),
				catch: () => new TopicMoveError({ code: "input_invalid" }),
			});
			const input = yield* body(Schema.Struct({ to: Schema.String }));
			const result = yield* service.move(
				{ from, to: input.to, ...(key === undefined ? {} : { key }) },
				authenticate(auth, request),
			);
			return HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
		}).pipe(
			Effect.catch((error) => {
				const code = Schema.is(TopicMoveError)(error)
					? error.code
					: Schema.is(AuthError)(error) && error.code === "invalid_request"
						? "input_invalid"
						: Schema.is(SourceRejected)(error) && error.code === "path_conflict"
							? "topic_exists"
							: Schema.is(SourceRejected)(error) && error.code === "invalid_path"
								? "input_invalid"
								: "topic_move_unavailable";
				const status =
					code === "credential_invalid"
						? 401
						: code === "scope_required"
							? 403
							: code === "topic_not_found"
								? 404
								: ["input_invalid", "body_invalid"].includes(code)
									? 400
									: ["topic_exists", "topic_archived", "topic_deleted", "idempotency_conflict"].includes(code)
										? 409
										: 503;
				return Effect.succeed(failure(code, status));
			}),
		);
	});
