import { databaseRestoreRoute, type DatabaseRestoreStore } from "./database-restore-http.ts";
import { backupRoute, type BackupStore } from "./backup-http.ts";
import { Clock, Crypto, Effect, Ref } from "effect";
import {
	Cookies,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";
import { authenticate, authErrorResponse, authFailure, authRoute, sessionCookie, type AuthStore } from "./auth-http.ts";
import { editRoute, type EditStore } from "./edit-http.ts";
import { passkeyManagementRoute } from "./passkey-management-http.ts";
import { accountRoute } from "./account-http.ts";
import { topicMoveRoute, type TopicMoveStore } from "./topic-move-http.ts";
import { tokenMintRoute } from "./token-mint-http.ts";
import { tokenRoute } from "./token-http.ts";
import { enrollmentRoute } from "./enrollment-http.ts";
import { eventRoute, type EventStore } from "./event-http.ts";
import type { RequestEvents } from "./request-events.ts";
import type { PublicPages } from "./public-pages.ts";
import type { SupervisedChild } from "./supervisor.ts";

const help = `comms local development bootloader

GET /health        Bootloader liveness (independent of the child).
GET /_boot/status  Child state and bounded stderr tail.
GET /_boot/generations  Persistent generation history (also /api/generations).
GET /_boot/db/backups  Human-only backup catalog.
POST /_boot/db/restore  Human-only database restore with a fresh db.restore assertion.
GET /api/events?since=0&wait=60  Read or wait for published events.
GET /api/stream?since=0  SSE with cursor resume, independent of app swaps.

Source snapshots and restart recovery are active. Child crashes retry their snapshot three times,
then try older known-good snapshots. Human passkey setup and login are available at /setup and /auth/login.
Private routes require a session or agent access token. POST /auth/enroll starts enrollment; approval uses a fresh passkey.
POST /auth/refresh rotates a refresh credential; retry with the same Idempotency-Key after a lost response.
GET /_boot/enrollments and /_boot/tokens list account metadata for the human session.
POST /_boot/tokens mints a pair with a human session and fresh token.mint assertion; keep the exact proof for retries.
GET /_boot/auth/passkeys lists keys; passkey.add and passkey.delete assertions authorize key changes.
POST /_boot/tokens/:family/revoke requires a human session and fresh token.revoke passkey assertion.
POST /api/lock acquires the editor; GET/PUT/DELETE /api/fs/app/<path> reads or stages source.
PUT ?reload=0 stages only; POST /api/reload rehearses and cuts over. Failed edits retain the repair lock.
POST /api/reload?release=1 releases the lock after a successful edit.
POST /api/revert {} undoes the latest app batch; {path}, {batch}, or {version} selects retained source history.
POST /api/revert {generation:n} restores a retained whole source tree and rebuilds its locked dependencies.
Revert needs your edit lock and empty staging; source must have complete retained provenance. Database restore remains separate.
Local commands bind to 127.0.0.1 by default. The development image publishes only to host loopback.
If first startup fails, repair source through /api/fs/app/<path> and POST /api/reload, or fix DATA_DIR/app and restart the launcher.
After a healthy startup, restarts use the newest known-good snapshot even if the editable source is broken.
`;

const reserved: readonly string[] = Object.freeze([
	"/api/fs",
	"/api/lock",
	"/api/reload",
	"/api/revert",
	"/api/generations",
	"/api/events",
	"/api/stream",
	"/api/tokens",
	"/auth",
	"/approve",
	"/setup",
]);
const hopHeaders: readonly string[] = Object.freeze([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export const proxy = (
	child: SupervisedChild,
	authStore: AuthStore,
	authConfig: AuthConfig,
	events: EventStore,
	editing: EditStore,
	publicPages: Ref.Ref<PublicPages["Service"] | null>,
	requests: RequestEvents,
	backups: BackupStore,
	restores: DatabaseRestoreStore,
	moves: TopicMoveStore,
	stopping?: Ref.Ref<boolean>,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const started = yield* Clock.monotonicTimeNanos;
		const url = new URL(request.url, "http://localhost");
		const path = url.pathname;
		// Reserve the child control namespace before any public or authenticated admission.
		const controlPath = yield* Effect.try(() => {
			const incomingPath = request.url.startsWith("/") ? new URL(`http://localhost${request.url}`).pathname : path;
			return new URL(`http://localhost${decodeURIComponent(incomingPath).replaceAll("\\", "/").replace(/\/+/g, "/")}`)
				.pathname;
		}).pipe(Effect.orElseSucceed(() => null));
		if (controlPath === null) return HttpServerResponse.empty({ status: 400 });
		if (controlPath === "/_kernel" || controlPath.startsWith("/_kernel/"))
			return HttpServerResponse.empty({ status: 403 });
		if (path === "/health" && (request.method === "GET" || request.method === "HEAD")) {
			return HttpServerResponse.jsonUnsafe({ status: "ok", mode: "local-development" });
		}
		if (path === "/_boot" && request.method === "GET") return HttpServerResponse.text(help);
		if (
			request.headers["x-boot-secret"] !== undefined ||
			path.startsWith("/_boot/seq") ||
			path === "/_boot/events/append"
		) {
			const internal = yield* eventRoute(events, child.attempts, null, child.channelGate);
			if (internal) return internal;
		}
		if (stopping && (yield* Ref.get(stopping))) return authErrorResponse("boot_unavailable", 503);
		const authResponse = yield* authRoute(authStore, authConfig);
		if (authResponse) return authResponse;
		const passkeyResponse = yield* passkeyManagementRoute(authStore, authConfig);
		if (passkeyResponse) return passkeyResponse;
		const enrollmentResponse = yield* enrollmentRoute(authStore, authConfig);
		if (enrollmentResponse) return enrollmentResponse;
		const backupResponse = yield* backupRoute(authStore, backups);
		if (backupResponse) return backupResponse;
		if (restores) {
			const restored = yield* databaseRestoreRoute(restores, authStore, authConfig);
			if (restored) return restored;
		}
		const accountResponse = yield* accountRoute(authStore);
		if (accountResponse) return accountResponse;
		const mintResponse = yield* tokenMintRoute(authStore, authConfig);
		if (mintResponse) return mintResponse;
		const tokenResponse = yield* tokenRoute(authStore, authConfig);
		if (tokenResponse) return tokenResponse;
		const auth = yield* Ref.get(authStore);
		const explicitCredential =
			request.headers.authorization !== undefined ||
			(request.headers.cookie ?? "").split(";").some((part) => part.trim().startsWith(`${sessionCookie}=`));
		let publicPage: string | null = null;
		if ((request.method === "GET" || request.method === "HEAD") && path.startsWith("/p/") && !explicitCredential) {
			const policy = yield* Ref.get(publicPages);
			if (policy) {
				const result = yield* policy.check(path).pipe(Effect.result);
				if (result._tag === "Failure") return authErrorResponse("boot_unavailable", 503);
				publicPage = result.success;
			}
		}
		const isPublic =
			(request.method === "GET" || request.method === "HEAD") &&
			([
				"/init",
				"/init.md",
				"/.well-known/agent.json",
				"/page-assets/markdown.css",
				"/page-assets/highlight.css",
				"/page-assets/mermaid.js",
				"/page-assets/mermaid-init.js",
				"/page-assets/tailwind.js",
			].includes(path) ||
				publicPage !== null);
		if (!auth && (!isPublic || explicitCredential)) return authErrorResponse("boot_unavailable", 503);
		return yield* authFailure(
			Effect.gen(function* () {
				let identity = auth && (!isPublic || explicitCredential) ? yield* authenticate(auth, request) : null;
				if (
					identity?.kind === "human" &&
					!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
					request.headers.origin !== authConfig.expectedOrigin
				)
					return yield* new AuthError({ code: "origin_invalid" });
				const expires = (response: HttpServerResponse.HttpServerResponse) =>
					identity
						? HttpServerResponse.setHeader(response, "x-comms-token-expires", String(identity.expiresAt))
						: response;
				if (identity && auth && moves) {
					const moved = yield* topicMoveRoute(moves, auth);
					if (moved) return expires(moved);
				}
				if (identity && auth) {
					const edited = yield* editRoute(editing, auth, identity);
					if (edited) return expires(edited);
				}
				const eventResponse = yield* eventRoute(
					events,
					child.attempts,
					identity,
					child.channelGate,
					auth
						? authenticate(auth, request).pipe(
								Effect.map((current) => current.scopes.includes("read")),
								Effect.orElseSucceed(() => false),
							)
						: Effect.succeed(false),
				);
				if (eventResponse) return expires(eventResponse);
				if (
					["/_boot/status", "/_boot/generations", "/api/generations"].includes(path) &&
					identity?.kind !== "human" &&
					!identity?.scopes.includes("fs")
				)
					return yield* new AuthError({ code: "scope_required" });
				let destination = yield* Ref.get(child.traffic.route);
				const state = yield* Ref.get(child.status);
				const safeState = { ...state, stderr: state.stderr.replace(/[a-f0-9]{64}/g, "[redacted]") };
				const generations = yield* Ref.get(child.generations);
				const lastGood = generations.find((generation) => generation.good === 1)?.n ?? null;
				if (path === "/_boot/status" && request.method === "GET") {
					return expires(
						HttpServerResponse.jsonUnsafe({
							mode: "local-development",
							authenticated: true,
							child: safeState,
							source_recovery_error: yield* Ref.get(child.sourceError),
							traffic: yield* child.traffic.state,
							last_good: lastGood,
						}),
					);
				}
				if ((path === "/_boot/generations" || path === "/api/generations") && request.method === "GET") {
					return expires(HttpServerResponse.jsonUnsafe({ items: generations, last_good: lastGood }));
				}
				if (
					path === "/_boot" ||
					path.startsWith("/_boot/") ||
					reserved.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
				) {
					return expires(
						HttpServerResponse.jsonUnsafe(
							{
								error: {
									code: "not_implemented",
									message: "This boot route is not implemented.",
									hint: "GET /_boot lists available routes.",
									retriable: false,
								},
							},
							{ status: 501 },
						),
					);
				}
				const unavailable = () =>
					HttpServerResponse.jsonUnsafe(
						{
							error: {
								code: "app_unavailable",
								message: "The server child is unavailable.",
								hint: "GET /_boot/status and /_boot/generations for diagnostics. GET /_boot explains local recovery.",
								retriable: true,
							},
							...(identity?.kind === "human" || identity?.scopes.includes("fs")
								? { child: safeState, last_good: lastGood }
								: {}),
						},
						{ status: 503 },
					);
				const requestAdmission = yield* child.traffic.requests.admit.pipe(Effect.result);
				if (requestAdmission._tag === "Failure") return expires(unavailable());
				if (publicPage !== null && !identity) {
					// Admission can wait across a database replacement. Recheck its current grants under the request lease.
					const policy = yield* Ref.get(publicPages);
					const checked = yield* (policy ? policy.check(path) : Effect.succeed(null)).pipe(Effect.result);
					if (checked._tag === "Failure") return authErrorResponse("boot_unavailable", 503);
					publicPage = checked.success;
					if (publicPage === null) return authErrorResponse("credential_required", 401);
				}
				destination = requestAdmission.success.destination;
				if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
					const admitted = yield* child.traffic.admit;
					destination = admitted.destination;
					if (admitted.waited && auth) identity = yield* authenticate(auth, request);
				}
				if (!destination) return expires(unavailable());
				const connectionHeaders = new Set(
					(request.headers.connection ?? "")
						.toLowerCase()
						.split(",")
						.map((name) => name.trim()),
				);
				const headers = Object.fromEntries(
					Object.entries(request.headers).filter(
						([name]) =>
							!hopHeaders.includes(name) &&
							!connectionHeaders.has(name) &&
							!name.startsWith("x-comms-") &&
							!name.startsWith("x-forwarded-") &&
							!["host", "authorization", "cookie", "x-boot-secret", "forwarded", "content-length"].includes(name),
					),
				);
				const crypto = yield* Crypto.Crypto;
				const requestId = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
				let outgoing = HttpClientRequest.make(request.method)(
					`http://127.0.0.1:${destination?.port}${path}${url.search}`,
					{
						headers: {
							...headers,
							...(request.headers["x-comms-init"] && /^[a-f0-9]{64}$/.test(request.headers["x-comms-init"])
								? { "x-comms-init": request.headers["x-comms-init"] }
								: {}),
							...(publicPage !== null && !identity ? { "x-comms-public-page": publicPage } : {}),
							"x-boot-secret": destination.secret,
							"x-comms-request-id": requestId,
							...(identity
								? {
										"x-comms-agent": identity.agent,
										"x-comms-auth-kind": identity.kind,
										"x-comms-instance": identity.id,
										"x-comms-scopes": identity.scopes.join(","),
										"x-comms-label": identity.label,
										"x-comms-token-expires": String(identity.expiresAt),
									}
								: {}),
						},
					},
				);
				if (
					request.method !== "GET" &&
					request.method !== "HEAD" &&
					((request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
						request.headers["transfer-encoding"] !== undefined)
				)
					outgoing = outgoing.pipe(
						HttpClientRequest.bodyStream(request.stream, { contentType: headers["content-type"] ?? "" }),
					);
				const client = yield* HttpClient.HttpClient;
				const observed = yield* requests({
					started,
					method: request.method,
					path,
					identity,
					generation: destination.generation,
					requestId,
				});
				return yield* client.execute(outgoing).pipe(
					Effect.map((response) => {
						const connection = new Set(
							(response.headers.connection ?? "")
								.toLowerCase()
								.split(",")
								.map((name) => name.trim()),
						);
						const converted = HttpServerResponse.fromClientResponse(response);
						const responseHeaders = Object.fromEntries(
							Object.entries(response.headers).filter(
								([name]) =>
									!hopHeaders.includes(name) &&
									!connection.has(name) &&
									name !== "x-boot-secret" &&
									(!name.startsWith("x-comms-") || ["x-comms-init-version", "x-comms-init-stale"].includes(name)) &&
									name !== "set-cookie",
							),
						);
						if (converted.body._tag !== "Stream")
							return HttpServerResponse.empty({ status: response.status, headers: responseHeaders });
						const forwarded = HttpServerResponse.empty({
							status: response.status,
							cookies: connection.has("set-cookie") ? Cookies.empty : Cookies.remove(response.cookies, sessionCookie),
						}).pipe(
							HttpServerResponse.setBody(HttpBody.stream(converted.body.stream, responseHeaders["content-type"] ?? "")),
							HttpServerResponse.setHeaders(responseHeaders),
						);
						return responseHeaders["content-type"] === undefined
							? HttpServerResponse.removeHeader(forwarded, "content-type")
							: forwarded;
					}),
					Effect.orElseSucceed(unavailable),
					Effect.tap((response) => observed.status(response.status)),
					Effect.map(expires),
				);
			}),
		);
	});
