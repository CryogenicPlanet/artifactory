import type { ChildError } from "./child-process.ts";
import type { RecoveryRejected } from "./recovery-intents.ts";
import { captureRefusal } from "./auth-primitives.ts";
import { bootRoute } from "./boot-route.ts";
import { requestBytes } from "./request-bytes.ts";
import { editFailure, errorResponse } from "./edit-failure.ts";
import type { SourceReverts } from "./source-revert.ts";
import { SourceResetParams } from "./source-reset-schema.ts";
import { Cause, Effect, Schema } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { assertionProof, authenticate, body, humanSession } from "./auth-http.ts";
import { databaseRestoreResponse } from "./database-restore-http.ts";
import type { DatabaseRestore } from "./database-restore.ts";
import type { Cutover } from "./cutover.ts";
import { EditAuthority, EditRejected, type EditLock, type Ownership } from "./edit-lock.ts";
import type { VerifiedIdentity } from "./enrollment.ts";
import { BreakLock } from "./lock-break.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SourceFiles } from "./source-files.ts";
import { SourceRejected } from "./source-schema.ts";

export interface Editing {
	readonly writable: boolean;
	readonly retryRecovery: (authorize: Effect.Effect<void, unknown>) => Effect.Effect<void, unknown>;
	readonly reverts: SourceReverts;
	readonly source: SourceFiles["Service"];
	readonly lock: EditLock["Service"];
	readonly cutover: Cutover;
	readonly withPagePublication: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<
		A,
		E | SourceRejected | EditRejected | ChildError | RecoveryRejected | SqlError | Schema.SchemaError,
		R
	>;
}

export const editRoute = (
	editing: Editing,
	auth: Auth["Service"],
	identity: VerifiedIdentity,
	restore: DatabaseRestore,
) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const route = url.pathname.replace(/^\/api\//, "/_boot/");
		if (
			route !== "/_boot/reset" &&
			route !== "/_boot/lock" &&
			route !== "/_boot/reload" &&
			route !== "/_boot/revert" &&
			!route.startsWith("/_boot/fs/")
		)
			return null;
		if (!identity.scopes.includes("fs")) return yield* new AuthError({ code: "scope_required" });
		return yield* Effect.gen(function* () {
			const writable = editing.writable;
			const repairLock =
				!writable &&
				identity.kind === "human" &&
				route === "/_boot/lock" &&
				["POST", "DELETE"].includes(request.method);
			const repairRevert =
				!writable && identity.kind === "human" && route === "/_boot/revert" && request.method === "POST";
			if (!writable && identity.kind === "human" && route === "/_boot/lock" && request.method === "GET") {
				if (url.search) return errorResponse("unsupported_query", 400);
				return HttpServerResponse.jsonUnsafe({ lock: yield* editing.lock.snapshot });
			}
			if (!writable && !repairLock && !repairRevert && (request.method !== "GET" || !route.startsWith("/_boot/fs/")))
				return errorResponse("editing_unavailable", 503);
			if (writable && route === "/_boot/lock" && ["POST", "DELETE"].includes(request.method))
				yield* editing.retryRecovery(Effect.asVoid(authenticate(auth, request)));
			// Failed recovery permits committed-source diagnostics, without lock expiry or staged-overlay mutation.
			const known = writable
				? (yield* editing.lock.inspect).value
				: repairLock || repairRevert
					? yield* editing.lock.snapshot
					: null;
			const owner = (): Ownership => ({ id: known?.id ?? "", family: identity.id });
			const authoritative = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
				Effect.gen(function* () {
					const current = yield* authenticate(auth, request);
					return yield* operation.pipe(
						Effect.provideService(EditAuthority, {
							...current,
							...(repairLock ? { repairLock: true } : {}),
							...(repairRevert ? { repairRevert: true } : {}),
						}),
					);
				});
			const lockResponse = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
				Effect.gen(function* () {
					const result = yield* operation.pipe(captureRefusal(Schema.is(EditRejected)));
					if (
						result._tag === "Failure" &&
						["lock_recovery_conflict", "authority_expired", "invalid_ttl"].includes(result.failure.code)
					)
						return yield* Effect.fail(result.failure);
					const recovery = repairLock
						? yield* editing.retryRecovery(Effect.asVoid(humanSession(auth, request))).pipe(
								Effect.as({ status: "ready" as const }),
								Effect.catchCause((cause) =>
									Cause.hasInterruptsOnly(cause)
										? Effect.failCause(cause)
										: Effect.succeed({
												status: "failed" as const,
												error: {
													code: "recovery_failed",
													message: "Lock operation committed; recovery still needs repair.",
													hint: "Inspect /_boot/status and recovery journals before retrying.",
													retriable: false,
												},
											}),
								),
							)
						: undefined;
					const lock = yield* Effect.fromResult(result);
					if (repairLock) yield* humanSession(auth, request);
					return HttpServerResponse.jsonUnsafe(
						{ lock, ...(recovery ? { lock_committed: true, recovery } : {}) },
						{ status: recovery?.status === "failed" ? 503 : 200, headers: { "cache-control": "no-store" } },
					);
				});
			if (route === "/_boot/reset") {
				if (request.method !== "POST") return errorResponse("method_invalid", 405);
				if (url.pathname !== "/_boot/reset" || url.search) return errorResponse("unsupported_query", 400);
				yield* body(SourceResetParams);
				const session = yield* humanSession(auth, request);
				const proof = yield* assertionProof(request);
				return HttpServerResponse.jsonUnsafe(
					yield* authoritative(
						editing.cutover.reset((digest) => auth.authorizeSourceReset(digest, proof, session.id), identity.agent),
					),
				);
			}
			if (route === "/_boot/lock") {
				if (request.method === "DELETE" && url.search === "?break=1") {
					const input = yield* body(BreakLock);
					const session = yield* humanSession(auth, request);
					const proof = yield* assertionProof(request);
					return yield* lockResponse(authoritative(auth.breakLock(input, proof, session.id)));
				}
				if (url.search) return errorResponse("unsupported_query", 400);
				if (request.method === "GET") return HttpServerResponse.jsonUnsafe({ lock: known });
				if (request.method === "POST") {
					const input = yield* body(
						Schema.Struct({ ttl: Schema.optionalKey(Schema.Int), note: Schema.optionalKey(Schema.String) }),
					);
					if ((input.note?.length ?? 0) > 1000) return errorResponse("invalid_note", 400);
					return yield* lockResponse(
						authoritative(editing.lock.acquire(identity.id, identity.agent, input)).pipe(
							Effect.map((outcome) => outcome.value),
						),
					);
				}
				if (request.method === "DELETE")
					return yield* lockResponse(
						authoritative(editing.lock.release(owner())).pipe(Effect.map((outcome) => outcome.value)),
					);
				return errorResponse("method_invalid", 405);
			}
			if (route === "/_boot/revert") {
				if (request.method !== "POST") return errorResponse("method_invalid", 405);
				if (url.search) return errorResponse("unsupported_query", 400);
				const input = yield* body(
					Schema.Struct({
						path: Schema.optionalKey(Schema.String),
						batch: Schema.optionalKey(Schema.String),
						version: Schema.optionalKey(Schema.Int),
						generation: Schema.optionalKey(Schema.Int),
						withDb: Schema.optionalKey(Schema.Boolean),
					}),
				);
				if (input.withDb === true) {
					if (
						input.generation === undefined ||
						!Number.isSafeInteger(input.generation) ||
						input.generation < 1 ||
						input.path !== undefined ||
						input.batch !== undefined ||
						input.version !== undefined
					)
						return errorResponse("revert_selection_invalid", 400);
					const session = yield* humanSession(auth, request);
					const proof = yield* assertionProof(request);
					const key = request.headers["idempotency-key"];
					return yield* databaseRestoreResponse(
						restore,
						{ generation: input.generation, withDb: true, ...(key === undefined ? {} : { idempotency_key: key }) },
						proof,
						session.id,
					);
				}
				if (
					[input.path, input.batch, input.version, input.generation].filter((value) => value !== undefined).length >
						1 ||
					input.path === "" ||
					input.batch === "" ||
					(input.version !== undefined && input.version < 1) ||
					(input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 1))
				)
					return errorResponse("revert_selection_invalid", 400);
				const key = request.headers["idempotency-key"];
				if (key !== undefined && !/^[\x20-\x7e]{1,128}$/.test(key))
					return errorResponse("idempotency_key_invalid", 400);
				const undo = input;
				const perform = (revertRequest?: string) =>
					Effect.gen(function* () {
						const currentLock =
							revertRequest === undefined
								? known
								: repairRevert
									? yield* editing.lock.snapshot
									: (yield* editing.lock.inspect).value;
						const owner = (): Ownership => ({ id: currentLock?.id ?? "", family: identity.id });
						if (identity.kind === "human" && !(yield* editing.source.undoTargetsPages(undo)))
							return HttpServerResponse.jsonUnsafe(
								yield* authoritative(
									editing.cutover.revertHuman(
										undo,
										identity,
										currentLock?.id,
										Effect.asVoid(humanSession(auth, request)),
										revertRequest,
									),
								),
							);
						if (input.generation !== undefined) {
							if (!currentLock)
								return yield* new EditRejected({ code: "lock_required", holder: null, transitions: [] });
							if (currentLock.holder_family !== identity.id)
								return yield* new EditRejected({ code: "locked", holder: currentLock, transitions: [] });
							return HttpServerResponse.jsonUnsafe(
								yield* authoritative(
									editing.cutover.reload(owner(), { undo, ...(revertRequest === undefined ? {} : { revertRequest }) }),
								),
							);
						}
						if (yield* editing.source.undoTargetsPages(undo))
							return yield* authoritative(
								editing.withPagePublication(
									Effect.acquireUseRelease(
										editing.source.preparePageUndo(identity.agent, undo),
										(id) =>
											Effect.gen(function* () {
												if (id === null) return yield* new SourceRejected({ code: "batch_missing", path: "pages" });
												yield* editing.source.publishWithAcceptance(
													id,
													revertRequest === undefined ? Effect.void : editing.reverts.bindPage(revertRequest, id),
												);
												return HttpServerResponse.jsonUnsafe({ published: true, batch: id });
											}),
										(id) => (id === null ? Effect.void : editing.source.discard(id).pipe(Effect.ignore)),
									),
								),
							);
						if (!currentLock) return yield* new EditRejected({ code: "lock_required", holder: null, transitions: [] });
						if (currentLock.holder_family !== identity.id)
							return yield* new EditRejected({ code: "locked", holder: currentLock, transitions: [] });
						return HttpServerResponse.jsonUnsafe(
							yield* authoritative(
								editing.cutover.reload(owner(), { undo, ...(revertRequest === undefined ? {} : { revertRequest }) }),
							),
						);
					});
				const completeRepair = <E, R>(operation: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
					operation.pipe(
						Effect.flatMap((response) =>
							Effect.gen(function* () {
								if (!repairRevert || response.status >= 400 || response.body._tag !== "Uint8Array") return response;
								const result = yield* Schema.decodeEffect(
									Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
								)(new TextDecoder().decode(response.body.body));
								if (result.status !== "live" && result.published !== true) return response;
								const recovery = yield* editing.retryRecovery(Effect.asVoid(humanSession(auth, request))).pipe(
									Effect.as({ status: "ready" as const }),
									Effect.catchCause((cause) =>
										Cause.hasInterruptsOnly(cause)
											? Effect.failCause(cause)
											: Effect.succeed({
													status: "failed" as const,
													error: {
														code: "recovery_failed",
														message: "Source revert committed; recovery still needs repair.",
														hint: "Inspect /_boot/status and recovery journals; do not repeat the revert with a new key.",
														retriable: false,
													},
												}),
									),
								);
								yield* humanSession(auth, request);
								return HttpServerResponse.jsonUnsafe(
									{ ...result, revert_committed: true, recovery },
									{ headers: { "cache-control": "no-store" } },
								);
							}),
						),
					);
				if (key === undefined) return yield* completeRepair(perform());
				const selector = yield* Schema.encodeEffect(
					Schema.fromJsonString(
						Schema.Struct({
							path: Schema.NullOr(Schema.String),
							batch: Schema.NullOr(Schema.String),
							version: Schema.NullOr(Schema.Int),
							generation: Schema.NullOr(Schema.Int),
						}),
					),
				)({
					path: input.path ?? null,
					batch: input.batch ?? null,
					version: input.version ?? null,
					generation: input.generation ?? null,
				});
				return yield* completeRepair(
					editing.reverts.run(
						{ family: identity.id, key },
						selector,
						Effect.gen(function* () {
							const current = yield* authenticate(auth, request);
							if (!current.scopes.includes("fs")) return yield* new AuthError({ code: "scope_required" });
						}),
						(id) => perform(id).pipe(Effect.catchCause(editFailure)),
					),
				);
			}
			if (
				[...url.searchParams.keys()].some(
					(key) => !["reload", "check", "release", "history", "baseVersion"].includes(key),
				)
			)
				return errorResponse("unsupported_query", 400);
			for (const key of ["reload", "check", "release"])
				if (url.searchParams.has(key) && !["0", "1"].includes(url.searchParams.get(key) ?? ""))
					return errorResponse("query_invalid", 400);
			if (route === "/_boot/reload") {
				if (url.searchParams.has("baseVersion")) return errorResponse("unsupported_query", 400);
				if (request.method !== "POST") return errorResponse("method_invalid", 405);
				yield* body(Schema.Struct({}));
				return HttpServerResponse.jsonUnsafe(
					yield* authoritative(
						editing.cutover.reload(owner(), {
							check: url.searchParams.get("check") === "1",
							release: url.searchParams.get("release") === "1",
						}),
					),
				);
			}
			const name = yield* Effect.try({
				try: () => decodeURIComponent(route.slice("/_boot/fs/".length)),
				catch: () => new SourceRejected({ code: "invalid_path", path: route }),
			});
			// A page refusal names pages; the docs work to keep the two apart and the text must not undo it.
			const subject = name.startsWith("pages/") ? "page" : "source";
			if (request.method === "GET") {
				if (url.searchParams.has("baseVersion"))
					return errorResponse("unsupported_query", 400, undefined, undefined, subject);
				if (url.searchParams.has("history"))
					return HttpServerResponse.jsonUnsafe({ items: yield* editing.source.history(name) });
				const directory = name.endsWith("/") ? name.slice(0, -1) : name;
				const reader = known?.holder_family === identity.id ? owner() : undefined;
				const items = yield* editing.source.browse(directory, reader);
				if (items !== null)
					return HttpServerResponse.jsonUnsafe({ items }, { headers: { "cache-control": "no-store" } });
				if (name.endsWith("/") || name === "app" || name === "pages")
					return errorResponse("file_not_found", 404, undefined, undefined, subject);
				const image = yield* editing.source.read(name, reader);
				if (image.content === null) return errorResponse("file_not_found", 404, undefined, undefined, subject);
				return HttpServerResponse.uint8Array(image.content, {
					headers: {
						"content-type":
							subject === "page" && name.toLowerCase().endsWith(".md")
								? "text/markdown; charset=utf-8"
								: "application/octet-stream",
						"x-chirp-base-version": image.sha ?? "",
						etag: `"${image.sha}"`,
						"cache-control": "no-store",
					},
				});
			}
			if (request.method !== "PUT" && request.method !== "DELETE")
				return errorResponse("method_invalid", 405, undefined, undefined, subject);
			const match = request.headers["if-match"];
			const absent = request.headers["if-none-match"];
			const tokens = url.searchParams.getAll("baseVersion");
			const token = tokens[0];
			if (
				(match !== undefined && (absent !== undefined || !/^"[a-f0-9]{64}"$/.test(match))) ||
				(absent !== undefined && absent !== "*") ||
				tokens.length > 1 ||
				(token !== undefined && (match !== undefined || absent !== undefined || !/^(?:[a-f0-9]{64}|null)$/.test(token)))
			)
				return errorResponse("precondition_invalid", 400, undefined, undefined, subject);
			const baseVersion =
				token === "null"
					? null
					: (token ?? (match !== undefined ? match.slice(1, -1) : absent === "*" ? null : undefined));
			if (request.method === "PUT" && baseVersion === undefined)
				return errorResponse("precondition_required", 400, undefined, undefined, subject);
			if (subject === "page") {
				if ([...url.searchParams.keys()].some((key) => key !== "baseVersion"))
					return errorResponse("unsupported_query", 400, undefined, undefined, subject);
				const content = request.method === "PUT" ? yield* readBytes(request, name) : null;
				return yield* authoritative(
					editing.withPagePublication(
						Effect.acquireUseRelease(
							editing.source.preparePages(identity.agent, [
								{ path: name, content, ...(baseVersion === undefined ? {} : { baseVersion }) },
							]),
							(id) =>
								editing.source
									.publish(id)
									.pipe(Effect.as(HttpServerResponse.jsonUnsafe({ published: true, batch: id }))),
							(id) => editing.source.discard(id).pipe(Effect.ignore),
						),
					),
				);
			}
			if (!known) return yield* new EditRejected({ code: "lock_required", holder: null, transitions: [] });
			if (known.holder_family !== identity.id)
				return yield* new EditRejected({ code: "locked", holder: known, transitions: [] });
			const content = request.method === "PUT" ? yield* readBytes(request, name) : null;
			yield* authoritative(editing.source.stage(owner(), name, content, baseVersion));
			if (url.searchParams.get("reload") === "0")
				return HttpServerResponse.jsonUnsafe({ staged: true, lock: (yield* editing.lock.inspect).value });
			return HttpServerResponse.jsonUnsafe(
				yield* authoritative(
					editing.cutover.reload(owner(), {
						check: url.searchParams.get("check") === "1",
						release: url.searchParams.get("release") === "1",
					}),
				),
			);
		}).pipe(Effect.catchCause(editFailure));
	});

const readBytes = (request: HttpServerRequest.HttpServerRequest, name: string) =>
	requestBytes(request, 8_388_608, new SourceRejected({ code: "invalid_text", path: name })).pipe(
		Effect.timeout("5 seconds"),
	);
