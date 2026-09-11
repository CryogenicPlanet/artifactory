import { isSqlError } from "effect/unstable/sql/SqlError";
import { ChildError } from "./child-process.ts";
import { StorageRejected } from "./storage-headroom.ts";
import { EventStorageRejected } from "./event-storage.ts";
import { ArtifactRetentionRejected } from "./artifact-retention.ts";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Constant-time comparison is not exposed by Effect Crypto.
import { timingSafeEqual } from "node:crypto";
import { Cause, DateTime, Effect, Ref, Schema, type Semaphore, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { DatabaseBackup } from "./database-backup.ts";
import type { Destination } from "./traffic.ts";
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
const reserveBody = Schema.Struct({ transaction: Schema.String, count: Schema.Int });
const abortBody = Schema.Struct({ transaction: Schema.String });
const failure = (code: string, status: number) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message: "Event operation unavailable.",
				hint:
					status === 500
						? "Inspect bootloader logs. This failure is not an unchanged-retry condition."
						: status === 507
							? "Free space on the data volume, then retry; existing publication and recovery remain available."
							: code === "unsafe_artifact_path"
								? "Inspect and repair boot-owned artifact paths before another request."
								: code === "scope_required"
									? "Re-enroll and ask the human to grant read scope."
									: "Retry infrastructure failures; inspect authenticated boot status.",
				retriable: status === 503,
			},
		},
		{ status },
	);
// Query and child mutation routes retain their existing distinct refusal statuses.
const eventStatus = {
	app_evidence_invalid: [400, 409],
	app_fence_invalid: [400, 409],
	app_store_missing: [400, 409],
	batch_conflict: [400, 409],
	batch_invalid: [400, 409],
	body_invalid: [400, 400],
	body_too_large: [400, 409],
	candidate_probe_committed: [400, 409],
	credential_expired: [401, 409],
	credential_invalid: [401, 409],
	cursor_ahead: [400, 409],
	events_unavailable: [503, 409],
	public_path_invalid: [400, 409],
	publication_pending: [400, 409],
	query_invalid: [400, 409],
	reservation_conflict: [400, 409],
	reservation_invalid: [400, 409],
	reservation_mismatch: [400, 409],
	sequence_exhausted: [400, 409],
	stale_attempt: [403, 409],
	topic_move_invalid: [400, 409],
	topic_move_recovery_required: [400, 409],
	topic_move_unprepared: [400, 409],
} as const satisfies Readonly<Record<EventError["code"], readonly [number, number]>>;
const eventFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, mode: 0 | 1, unavailable = "events_unavailable") =>
	effect.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause))
				return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));
			const expected =
				cause.reasons.length > 0 &&
				cause.reasons.every(
					(reason) =>
						reason._tag === "Fail" &&
						(Schema.is(EventError)(reason.error) ||
							Schema.is(StorageRejected)(reason.error) ||
							Schema.is(EventStorageRejected)(reason.error) ||
							Schema.is(ArtifactRetentionRejected)(reason.error) ||
							Schema.is(ChildError)(reason.error) ||
							Cause.isTimeoutError(reason.error) ||
							(isSqlError(reason.error) && reason.error.isRetryable)),
				);
			if (!expected) return Effect.succeed(failure("handler_failed", 500));
			for (const reason of cause.reasons) {
				if (reason._tag !== "Fail") continue;
				const error = reason.error;
				if (Schema.is(EventError)(error)) return Effect.succeed(failure(error.code, eventStatus[error.code][mode]));
				if (
					Schema.is(StorageRejected)(error) ||
					Schema.is(EventStorageRejected)(error) ||
					Schema.is(ArtifactRetentionRejected)(error)
				)
					return Effect.succeed(failure(error.code, error.code === "unsafe_artifact_path" ? 409 : 507));
			}
			return Effect.succeed(failure(unavailable, 503));
		}),
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
	service: Events["Service"],
	attempts: Ref.Ref<readonly Attempt[]>,
	identity: VerifiedIdentity | null,
	gate: Semaphore.Semaphore,
	route: Ref.Ref<Destination | null>,
	revalidate: Effect.Effect<boolean> = Effect.succeed(true),
	backup?: DatabaseBackup,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const capture = url.pathname === "/_boot/db/backup" && request.headers["x-boot-secret"] !== undefined;
		const internal =
			capture ||
			["/_boot/seq", "/_boot/seq/reserve", "/_boot/seq/abort", "/_boot/events/append"].includes(url.pathname);
		const query = ["/_boot/events", "/api/events"].includes(url.pathname);
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
		if (capture) {
			if (request.method !== "POST") return failure("method_invalid", 405);
			if (url.search || bodyText?._tag !== "Success") return failure("body_invalid", 400);
			const empty = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Never), {
				onExcessProperty: "error",
			})(bodyText.success).pipe(Effect.result);
			if (empty._tag === "Failure") return failure("body_invalid", 400);
			if (!backup || !attempt) return failure("backup_unavailable", 503);
			// Capture drains app writers, whose final publications need the channel gate.
			// The operation gate revalidates this exact epoch before touching traffic.
			return yield* backup
				.capture({ reason: "hourly", epoch: attempt.epoch })
				.pipe(Effect.map(HttpServerResponse.jsonUnsafe), (effect) => eventFailure(effect, 1, "backup_unavailable"));
		}
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
			}).pipe((effect) => eventFailure(effect, 0));
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
			return yield* publicEventResponse(request, identity, read, service.changed).pipe((effect) =>
				eventFailure(effect, 0),
			);
		}
		return yield* gate
			.withPermit(
				Effect.gen(function* () {
					let starting = false;
					let completion = false;
					if (attempt) {
						const admitted = (yield* Ref.get(attempts)).find((item) => item.epoch === attempt?.epoch);
						if (!admitted) return failure("stale_attempt", 403);
						starting = admitted.state === "starting";
						completion = admitted.state === "accepted" && (yield* Ref.get(route))?.epoch !== admitted.epoch;
						if (admitted.state === "starting" && url.pathname === "/_boot/events/append")
							return failure("child_not_live", 409);
					}
					if (bodyText && bodyText._tag === "Failure") return failure("body_invalid", 400);
					const bodyValue = bodyText ? bodyText.success : undefined;

					if (!attempt) return failure("child_forbidden", 403);
					if (request.method !== "POST") return failure("method_invalid", 405);
					if (url.pathname === "/_boot/seq/reserve") {
						const body = yield* Schema.decodeUnknownEffect(reserveBody)(bodyValue).pipe(
							Effect.mapError(() => new EventError({ code: "body_invalid" })),
						);
						return HttpServerResponse.jsonUnsafe(
							yield* (starting || (completion && body.count === 1) ? service.reserveStartup : service.reserve)(
								body.transaction,
								body.count,
								attempt.epoch,
							),
						);
					}
					if (url.pathname === "/_boot/seq/abort") {
						const body = yield* Schema.decodeUnknownEffect(abortBody)(bodyValue).pipe(
							Effect.mapError(() => new EventError({ code: "body_invalid" })),
						);
						yield* service.abort(body.transaction, attempt.epoch);
						return HttpServerResponse.empty({ status: 204 });
					}
					if (url.pathname === "/_boot/events/append") {
						const body = yield* Schema.decodeUnknownEffect(Batch)(bodyValue).pipe(
							Effect.mapError(() => new EventError({ code: "body_invalid" })),
						);
						if (
							completion &&
							(yield* service.state).pending_id === body.transaction &&
							(body.events.length !== 1 || body.events[0]?.type !== "pages.public")
						)
							return failure("completion_event_invalid", 409);
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
			.pipe((effect) => eventFailure(effect, 1));
	});
