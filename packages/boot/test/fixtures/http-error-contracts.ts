import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Ref, Schema, Semaphore } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { LockTimeoutError, SqlError, SqlSyntaxError } from "effect/unstable/sql/SqlError";
import { AuthError } from "../../src/auth.ts";
import { authFailure } from "../../src/auth-http.ts";
import { ChildError } from "../../src/child-process.ts";
import { EventError, type Events } from "../../src/events.ts";
import { eventRoute, type Attempt } from "../../src/event-http.ts";
import { TrafficError, type Destination } from "../../src/traffic.ts";

const program = Effect.gen(function* () {
	const retryable = new SqlError({ reason: new LockTimeoutError({ cause: "locked" }) });
	const syntax = new SqlError({ reason: new SqlSyntaxError({ cause: "broken SQL" }) });
	const check = (response: HttpServerResponse.HttpServerResponse, status: number, code: string) =>
		Effect.gen(function* () {
			assert.equal(response.status, status);
			const value = yield* HttpServerResponse.toClientResponse(response).json.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Struct({
							error: Schema.Struct({ code: Schema.String, retriable: Schema.Boolean, hint: Schema.String }),
						}),
					),
				),
			);
			assert.equal(value.error.code, code);
			assert.equal(value.error.retriable, status === 503);
			assert.ok(value.error.hint.length > 0);
		});
	for (const [error, status, code] of [
		[new AuthError({ code: "token_expired" }), 401, "token_expired"],
		[new AuthError({ code: "scope_required" }), 403, "scope_required"],
		[new ChildError({ code: "child_closure_unproven" }), 503, "boot_unavailable"],
		[new TrafficError({ code: "freeze_queue_full" }), 503, "boot_unavailable"],
		[retryable, 503, "boot_unavailable"],
		[syntax, 500, "handler_failed"],
		[{ _tag: "AuthError", code: "future_unknown_code" }, 500, "handler_failed"],
		[{ _tag: "ChildError", code: "private diagnostic accidentally in code" }, 500, "handler_failed"],
	] as const)
		yield* check(yield* authFailure(Effect.fail(error)), status, code);
	for (const failure of [
		Effect.die("private defect"),
		Effect.fail(new AuthError({ code: "session_invalid" })).pipe(
			Effect.ensuring(Effect.die("private finalizer defect")),
		),
		Effect.fail(retryable).pipe(Effect.ensuring(Effect.die("private finalizer defect"))),
		Effect.failCause(
			Cause.combine(Cause.fail(new AuthError({ code: "session_invalid" })), Cause.fail("unknown sibling")),
		),
	])
		yield* check(yield* authFailure<unknown, never>(failure), 500, "handler_failed");
	for (const [schema, tag] of [
		[AuthError, "AuthError"],
		[ChildError, "ChildError"],
		[EventError, "EventError"],
		[TrafficError, "TrafficError"],
	] as const)
		assert.equal(Schema.is(schema)({ _tag: tag, code: "future_unknown_code" }), false);

	const attempts = yield* Ref.make<readonly Attempt[]>([]);
	const route = yield* Ref.make<Destination | null>(null);
	const gate = yield* Semaphore.make(1);
	const identity = {
		kind: "human" as const,
		id: "session",
		agent: "rahul",
		label: "human",
		scopes: ["read"],
		expiresAt: 9999999999999,
	};
	const request = HttpServerRequest.fromWeb(new Request("http://localhost/api/events?since=0"));
	for (const [failure, status, code] of [
		[Effect.fail(new EventError({ code: "query_invalid" })), 400, "query_invalid"],
		[Effect.fail(new EventError({ code: "events_unavailable" })), 503, "events_unavailable"],
		[Effect.fail(retryable), 503, "events_unavailable"],
		[Effect.fail(syntax), 500, "handler_failed"],
		[Effect.die("event defect"), 500, "handler_failed"],
		[
			Effect.fail(new EventError({ code: "events_unavailable" })).pipe(Effect.ensuring(Effect.die("cleanup defect"))),
			500,
			"handler_failed",
		],
	] as const) {
		const unused = Effect.die("Unexpected test operation");
		const service: Events["Service"] = {
			state: unused,
			changed: () => unused,
			stopWaiting: Effect.void,
			append: () => unused,
			abort: () => unused,
			reserve: () => unused,
			reserveStartup: () => unused,
			writeBoot: () => unused,
			query: () => failure,
		};
		const response = yield* eventRoute(service, attempts, identity, gate, route).pipe(
			Effect.provideService(HttpServerRequest.HttpServerRequest, request),
		);
		assert.ok(response);
		yield* check(response, status, code);
	}
	yield* Console.log("HTTP_ERROR_CONTRACTS_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
