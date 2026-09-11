import { Cause, Effect, Ref, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import { assertionProof, authenticate, body, humanSession } from "./auth-http.ts";
import type { Cutover } from "./cutover.ts";
import { EditAuthority, EditRejected, type EditLock, type Ownership } from "./edit-lock.ts";
import type { VerifiedIdentity } from "./enrollment.ts";
import { BreakLock } from "./lock-break-schema.ts";
import type { PublicPages } from "./public-pages.ts";
import type { SourceFiles } from "./source-files.ts";
import { SourceRejected } from "./source-schema.ts";

export interface Editing {
	readonly source: SourceFiles["Service"];
	readonly lock: EditLock["Service"];
	readonly cutover: Cutover;
	readonly pages: PublicPages["Service"];
}
export type EditStore = Ref.Ref<Editing | null>;
const errorResponse = (code: string, status: number, holder?: unknown) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message: "Source edit refused.",
				hint:
					code === "topic_archived"
						? "Unarchive the topic and its archived ancestors before changing its pages."
						: "GET /_boot/status for diagnostics. POST /api/lock before app edits; repair staged source and POST /api/reload to retry.",
				retriable: status === 503,
			},
			...(holder === undefined ? {} : { lock: holder }),
		},
		{ status, headers: { "cache-control": "no-store" } },
	);

export const editRoute = (store: EditStore, auth: Auth["Service"], identity: VerifiedIdentity) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost");
		const route = url.pathname.replace(/^\/api\//, "/_boot/");
		if (
			route !== "/_boot/lock" &&
			route !== "/_boot/reload" &&
			route !== "/_boot/revert" &&
			!route.startsWith("/_boot/fs/")
		)
			return null;
		if (!identity.scopes.includes("fs")) return yield* new AuthError({ code: "scope_required" });
		const editing = yield* Ref.get(store);
		if (!editing) return errorResponse("editing_unavailable", 503);
		return yield* Effect.gen(function* () {
			const known = (yield* editing.lock.inspect).value;
			const owner = (): Ownership => ({ id: known?.id ?? "", family: identity.id });
			const authoritative = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
				Effect.gen(function* () {
					const current = yield* authenticate(auth, request);
					return yield* operation.pipe(Effect.provideService(EditAuthority, current));
				});
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
				if (input.withDb === true) return errorResponse("database_restore_unavailable", 501);
				if (input.generation !== undefined) return errorResponse("generation_revert_unavailable", 501);
				if (
					[input.path, input.batch, input.version].filter((value) => value !== undefined).length > 1 ||
					input.path === "" ||
					input.batch === "" ||
					(input.version !== undefined && input.version < 1)
				)
					return errorResponse("revert_selection_invalid", 400);
				const key = request.headers["idempotency-key"];
				if (key !== undefined && !/^[\x20-\x7e]{1,128}$/.test(key))
					return errorResponse("idempotency_key_invalid", 400);
				const undo = { ...input, ...(key === undefined ? {} : { retry: { family: identity.id, key } }) };
				return yield* authoritative(
					Effect.acquireUseRelease(
						editing.source.preparePageUndo(identity.agent, undo),
						(id) =>
							Effect.gen(function* () {
								if (id !== null) {
									yield* editing.pages.withWrite(yield* editing.source.proposalPaths(id), editing.source.publish(id));
									return HttpServerResponse.jsonUnsafe({ published: true, batch: id });
								}
								if (!known) return yield* new EditRejected({ code: "lock_required", holder: null, transitions: [] });
								if (known.holder_family !== identity.id)
									return yield* new EditRejected({ code: "locked", holder: known, transitions: [] });
								return HttpServerResponse.jsonUnsafe(yield* editing.cutover.reload(owner(), { undo }));
							}),
						(id) => (id === null ? Effect.void : editing.source.discard(id).pipe(Effect.ignore)),
					),
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
					editing.pages.withWrite(
						[name],
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
		}).pipe(
			Effect.catch((error) => {
				if (Schema.is(EditRejected)(error))
					return Effect.succeed(
						errorResponse(error.code, error.code === "authority_expired" ? 401 : 423, error.holder),
					);
				if (Schema.is(SourceRejected)(error))
					return Effect.succeed(
						errorResponse(
							error.code,
							error.code === "publication_pending"
								? 503
								: [
											"stale_base",
											"ambiguous_anchor",
											"anchor_not_found",
											"idempotency_conflict",
											"topic_deleted",
											"topic_archived",
									  ].includes(error.code)
									? 409
									: 400,
						),
					);
				if (Schema.is(AuthError)(error)) return Effect.succeed(errorResponse(error.code, 401));
				return Effect.succeed(errorResponse("edit_unavailable", 503));
			}),
			Effect.catchCauseIf(
				(cause) => !Cause.hasInterruptsOnly(cause),
				() => Effect.succeed(errorResponse("edit_unavailable", 503)),
			),
		);
	});

const readBytes = (request: HttpServerRequest.HttpServerRequest, name: string) =>
	Effect.gen(function* () {
		let bytes = 0;
		const chunks = yield* request.stream.pipe(
			Stream.tap((chunk) =>
				Effect.gen(function* () {
					bytes += chunk.byteLength;
					if (bytes > 8_388_608) return yield* new SourceRejected({ code: "invalid_text", path: name });
				}),
			),
			Stream.runCollect,
			Effect.timeout("5 seconds"),
		);
		return Buffer.concat(chunks);
	});
