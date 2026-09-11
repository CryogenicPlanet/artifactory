import { requestBytes } from "./request-bytes.ts";
import { editFailure, errorResponse } from "./edit-failure.ts";
import type { SourceReverts } from "./source-revert.ts";
import { SourceResetParams } from "./source-reset-schema.ts";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { assertionProof, authenticate, body, humanSession } from "./auth-http.ts";
import { databaseRestoreResponse } from "./database-restore-http.ts";
import type { DatabaseRestore } from "./database-restore.ts";
import type { Cutover } from "./cutover.ts";
import type { BootMetrics } from "./metrics.ts";
import { EditAuthority, EditRejected, type EditLock, type Ownership } from "./edit-lock.ts";
import type { VerifiedIdentity } from "./enrollment.ts";
import { BreakLock } from "./lock-break-schema.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SourceFiles } from "./source-files.ts";
import { SourceRejected } from "./source-schema.ts";

export interface Editing {
	readonly writable: boolean;
	readonly reverts: SourceReverts;
	readonly source: SourceFiles["Service"];
	readonly lock: EditLock["Service"];
	readonly cutover: Cutover;
	readonly withPagePublication: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | SourceRejected | SqlError | Schema.SchemaError, R>;
}

export const editRoute = (
	editing: Editing,
	auth: Auth["Service"],
	identity: VerifiedIdentity,
	metrics: BootMetrics,
	restore: DatabaseRestore,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
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
		if (!editing.writable && (request.method !== "GET" || !route.startsWith("/_boot/fs/")))
			return errorResponse("editing_unavailable", 503);
		return yield* Effect.gen(function* () {
			// Failed recovery permits committed-source diagnostics, without lock expiry or staged-overlay mutation.
			const known = editing.writable ? (yield* editing.lock.inspect).value : null;
			const owner = (): Ownership => ({ id: known?.id ?? "", family: identity.id });
			const authoritative = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
				Effect.gen(function* () {
					const current = yield* authenticate(auth, request);
					return yield* operation.pipe(Effect.provideService(EditAuthority, current));
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
					return HttpServerResponse.jsonUnsafe(
						{ lock: yield* auth.breakLock(input, proof, session.id) },
						{ headers: { "cache-control": "no-store" } },
					);
				}
				if (url.search) return errorResponse("unsupported_query", 400);
				if (request.method === "GET") return HttpServerResponse.jsonUnsafe({ lock: known });
				if (request.method === "POST") {
					const input = yield* body(
						Schema.Struct({ ttl: Schema.optionalKey(Schema.Int), note: Schema.optionalKey(Schema.String) }),
					);
					if ((input.note?.length ?? 0) > 1000) return errorResponse("invalid_note", 400);
					return HttpServerResponse.jsonUnsafe({
						lock: (yield* authoritative(editing.lock.acquire(identity.id, identity.agent, input))).value,
					});
				}
				if (request.method === "DELETE")
					return HttpServerResponse.jsonUnsafe({ lock: (yield* authoritative(editing.lock.release(owner()))).value });
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
						const currentLock = revertRequest === undefined ? known : (yield* editing.lock.inspect).value;
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
				if (key === undefined) return yield* perform();
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
				return yield* editing.reverts.run(
					{ family: identity.id, key },
					selector,
					Effect.gen(function* () {
						const current = yield* authenticate(auth, request);
						if (!current.scopes.includes("fs")) return yield* new AuthError({ code: "scope_required" });
					}),
					(id) => perform(id).pipe(Effect.catchCause(editFailure(metrics))),
				);
			}
			if ([...url.searchParams.keys()].some((key) => !["reload", "check", "release", "history"].includes(key)))
				return errorResponse("unsupported_query", 400);
			for (const key of ["reload", "check", "release"])
				if (url.searchParams.has(key) && !["0", "1"].includes(url.searchParams.get(key) ?? ""))
					return errorResponse("query_invalid", 400);
			if (route === "/_boot/reload") {
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
			if (request.method === "GET") {
				if (url.searchParams.has("history"))
					return HttpServerResponse.jsonUnsafe({ items: yield* editing.source.history(name) });
				const directory = name.endsWith("/") ? name.slice(0, -1) : name;
				const reader = known?.holder_family === identity.id ? owner() : undefined;
				const items = yield* editing.source.browse(directory, reader);
				if (items !== null)
					return HttpServerResponse.jsonUnsafe({ items }, { headers: { "cache-control": "no-store" } });
				if (name.endsWith("/") || name === "app" || name === "pages") return errorResponse("file_not_found", 404);
				const image = yield* editing.source.read(name, reader);
				if (image.content === null) return errorResponse("file_not_found", 404);
				return HttpServerResponse.uint8Array(image.content, {
					headers: { "content-type": "application/octet-stream", "x-comms-base-version": image.sha ?? "" },
				});
			}
			if (
				request.method !== "PUT" &&
				request.method !== "DELETE" &&
				!(route === "/_boot/fs/edit" && request.method === "POST")
			)
				return errorResponse("method_invalid", 405);
			if (name.startsWith("pages/")) {
				if (request.method !== "PUT" && request.method !== "DELETE") return errorResponse("method_invalid", 405);
				if (url.search) return errorResponse("unsupported_query", 400);
				const content = request.method === "PUT" ? yield* readBytes(request, name) : null;
				return yield* authoritative(
					editing.withPagePublication(
						Effect.acquireUseRelease(
							editing.source.preparePages(identity.agent, [{ path: name, content }]),
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
			if (route === "/_boot/fs/edit") {
				const input = yield* body(
					Schema.Struct({
						path: Schema.String,
						edits: Schema.Array(
							Schema.Struct({
								old_string: Schema.String,
								new_string: Schema.String,
								replace_all: Schema.optionalKey(Schema.Boolean),
							}),
						),
						baseVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
					}),
				);
				yield* authoritative(editing.source.edit(owner(), input.path, input.edits, input.baseVersion));
			} else {
				let content: Uint8Array | null = null;
				if (request.method === "PUT") {
					content = yield* readBytes(request, name);
				}
				yield* authoritative(editing.source.stage(owner(), name, content));
			}
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
		}).pipe(Effect.catchCause(editFailure(metrics)));
	});

const readBytes = (request: HttpServerRequest.HttpServerRequest, name: string) =>
	requestBytes(request, 8_388_608, new SourceRejected({ code: "invalid_text", path: name })).pipe(
		Effect.timeout("5 seconds"),
	);
