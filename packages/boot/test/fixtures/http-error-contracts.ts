import { editFailure } from "../../src/edit-failure.ts";
import { childErrorPolicy } from "../../src/child-error-policy.ts";
import { EditRejected } from "../../src/edit-lock.ts";
import { SourceRejected } from "../../src/source-schema.ts";
import { metrics } from "../../src/metrics.ts";
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
		[new ChildError({ code: "child_closure_unproven" }), 409, "child_closure_unproven"],
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

	const meter = yield* metrics;
	const edit = <E>(effect: Effect.Effect<never, E>) => effect.pipe(Effect.catchCause(editFailure(meter)));
	// Each known child failure retains its identity on both recovery HTTP boundaries.
	for (const [code, detail] of Object.entries(childErrorPolicy)) {
		const error = yield* Schema.decodeUnknownEffect(ChildError)({ _tag: "ChildError", code });
		yield* check(yield* edit(Effect.fail(error)), detail.status, code);
		yield* check(yield* authFailure(Effect.fail(error)), detail.status, code);
	}
	for (const [error, status, code] of [
		[new SourceRejected({ code: "external_conflict", path: "pages/private.txt" }), 409, "external_conflict"],
		[new SourceRejected({ code: "publication_pending", path: "recovery" }), 503, "publication_pending"],
		[new AuthError({ code: "scope_required" }), 403, "scope_required"],
		[new AuthError({ code: "origin_invalid" }), 403, "origin_invalid"],
		[new EditRejected({ code: "authority_expired", holder: null, transitions: [] }), 401, "authority_expired"],
		[new EditRejected({ code: "locked", holder: null, transitions: [] }), 423, "locked"],
		[retryable, 503, "edit_unavailable"],
	] as const)
		yield* check(yield* edit(Effect.fail(error)), status, code);
	const editRequest = HttpServerRequest.fromWeb(
		new Request("http://localhost/api/revert?private=query-secret", { method: "POST" }),
	);
	for (const failure of [
		Effect.die("private defect"),
		Effect.fail(syntax),
		Effect.fail(new ChildError({ code: "cutover_recovery_required" })).pipe(
			Effect.ensuring(Effect.die("private cleanup defect")),
		),
		Effect.failCause(
			Cause.combine(
				Cause.fail(new SourceRejected({ code: "external_conflict", path: "secret-path" })),
				Cause.fail("unknown sibling"),
			),
		),
		Effect.fail({ _tag: "ChildError", code: "future_unknown_code" }),
		Effect.failCause(
			Cause.combine(Cause.fail(retryable), Cause.fail(new ChildError({ code: "cutover_recovery_required" }))),
		),
		Effect.failCause(
			Cause.combine(
				Cause.fail(new ChildError({ code: "boot_shutting_down" })),
				Cause.fail(new ChildError({ code: "child_closure_unproven" })),
			),
		),
	]) {
		for (const handled of [edit<unknown>(failure), authFailure<unknown, never>(failure)]) {
			const response = yield* handled.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, editRequest));
			yield* check(response, 500, "handler_failed");
			const value = yield* HttpServerResponse.toClientResponse(response).json;
			const encoded = JSON.stringify(value);
			assert.ok(encoded.includes("POST /api/revert"));
			for (const secret of [
				"query-secret",
				"private defect",
				"private cleanup defect",
				"unknown sibling",
				"secret-path",
			])
				assert.ok(!encoded.includes(secret));
		}
	}
	const cancelled = yield* edit(Effect.interrupt).pipe(Effect.exit);
	assert.equal(cancelled._tag, "Failure");
	if (cancelled._tag === "Failure") assert.ok(Cause.hasInterruptsOnly(cancelled.cause));
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
		if (code === "handler_failed") {
			const value = yield* HttpServerResponse.toClientResponse(response).json;
			assert.ok(JSON.stringify(value).includes("GET /api/events"));
		}
	}
	yield* Console.log("HTTP_ERROR_CONTRACTS_VERIFIED");
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
program.pipe(BunRuntime.runMain);
