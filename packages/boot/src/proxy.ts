import { redactHex } from "./auth-primitives.ts";
import { recoveryRoute } from "./recovery-http.ts";
import { settingsRoute } from "./settings-http.ts";
import { discoveryResponse } from "./route-discovery.ts";
import { restartRoute } from "./restart-http.ts";
import { databaseRestoreRoute } from "./database-restore-http.ts";
import { backupRoute } from "./backup-http.ts";
import { Clock, Crypto, Effect, Ref, Stream } from "effect";
import {
	Cookies,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { Auth, AuthError } from "./auth.ts";
import { authenticate, authErrorResponse, authFailure, authRoute, sessionCookie } from "./auth-http.ts";
import { editRoute } from "./edit-http.ts";
import { passkeyManagementRoute } from "./passkey-management-http.ts";
import { accountRoute } from "./account-http.ts";
import { tokenMintRoute } from "./token-mint-http.ts";
import { tokenRoute } from "./token-http.ts";
import { enrollmentRoute } from "./enrollment-http.ts";
import { eventRoute } from "./event-http.ts";
import { PublicPages } from "./public-pages.ts";
import { BootHttp } from "./boot-http.ts";
import { Events } from "./events.ts";

const help = `comms local development bootloader

GET /_boot/settings  Human-only revisioned retention, storage percentages and public paths.
POST /_boot/settings  Change {revision,patch} with a fresh settings.change assertion; retain proof for exact retries.
GET /health        Bootloader liveness (independent of the child).
GET /_boot/recovery  Human source-recovery page, independent of the child.
GET /_boot/status  Child state and bounded stderr tail.
GET /_boot/metrics  Prometheus metrics; human session or fs-scoped bearer.
GET /_boot/generations  Persistent generation history (also /api/generations).
GET /_boot/db/backups  Human-only backup catalog.
POST /_boot/db/backup  Capture a consistent app backup (human or fs scope).
POST /_boot/db/restore  Human-only database restore with a fresh db.restore assertion.
POST /_boot/restart {}  Human session and fresh boot.restart assertion; exits for the external supervisor to restart.
POST /_boot/reset {}  Human-only source reset to image seed with a fresh app.reset assertion; data and pages stay current.
GET /api/events?since=0&wait=60  Read or wait for published events.

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
Source-only revert needs your edit lock and empty staging; source must have complete retained provenance.
POST /api/revert {generation:n,withDb:true} restores source and its exact pre-flip backup with a fresh generation.restore assertion.
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

export const proxy = Effect.gen(function* () {
	const { child, authConfig, editing, requests, backups, restores, captures, phase, restart } = yield* BootHttp;
	const auth = yield* Auth;
	const events = yield* Events;
	const publicPages = yield* PublicPages;
	const request = yield* HttpServerRequest.HttpServerRequest;
	const started = yield* Clock.monotonicTimeNanos;
	const url = new URL(request.url, "http://localhost");
	const path = url.pathname;
	const crypto = yield* Crypto.Crypto;
	const requestId = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
	// Polls and the child protocol must not manufacture events that wake themselves.
	const excluded =
		["/health", "/_boot/status", "/_boot/metrics", "/api/events", "/_boot/events", "/api/stream"].includes(path) ||
		path === "/_kernel" ||
		path.startsWith("/_kernel/") ||
		path.startsWith("/_boot/seq") ||
		path.startsWith("/_boot/events/") ||
		(path === "/_boot/db/backup" && request.headers["x-boot-secret"] !== undefined);
	const observed = excluded
		? null
		: yield* requests({
				started,
				method: request.method,
				path,
				identity: null,
				generation: 0,
				requestId,
			});
	const routed = Effect.gen(function* () {
		const publicResponse = yield* publicRoute;
		if (publicResponse) return publicResponse;
		if (
			request.headers["x-boot-secret"] !== undefined ||
			path.startsWith("/_boot/seq") ||
			path === "/_boot/events/append"
		) {
			const internal = yield* eventRoute(
				events,
				child.attempts,
				null,
				child.channelGate,
				child.traffic.route,
				Effect.succeed(true),
				captures,
			);
			if (internal) return internal;
		}
		if ((yield* Ref.get(phase))._tag === "Stopping") return authErrorResponse("boot_unavailable", 503);
		const recoveryResponse = yield* recoveryRoute(auth);
		if (recoveryResponse) return recoveryResponse;
		const settingsResponse = yield* settingsRoute(auth, authConfig);
		if (settingsResponse) return settingsResponse;
		const restarted = yield* restartRoute(auth, authConfig, restart);
		if (restarted) return restarted;
		const authResponse = yield* authRoute(auth, authConfig);
		if (authResponse) return authResponse;
		const passkeyResponse = yield* passkeyManagementRoute(auth, authConfig);
		if (passkeyResponse) return passkeyResponse;
		const enrollmentResponse = yield* enrollmentRoute(auth, authConfig, editing);
		if (enrollmentResponse) return enrollmentResponse;
		if (
			(yield* Ref.get(phase))._tag !== "Ready" &&
			request.method === "POST" &&
			["/_boot/db/backup", "/_boot/db/restore"].includes(path)
		)
			return authErrorResponse("boot_unavailable", 503);
		const backupResponse = yield* backupRoute(auth, backups, captures, authConfig);
		if (backupResponse) return backupResponse;
		const restored = yield* databaseRestoreRoute(restores, auth, authConfig);
		if (restored) return restored;
		const accountResponse = yield* accountRoute(auth);
		if (accountResponse) return accountResponse;
		const mintResponse = yield* tokenMintRoute(auth, authConfig);
		if (mintResponse) return mintResponse;
		const tokenResponse = yield* tokenRoute(auth, authConfig);
		if (tokenResponse) return tokenResponse;
		const explicitCredential =
			request.headers.authorization !== undefined ||
			(request.headers.cookie ?? "").split(";").some((part) => part.trim().startsWith(`${sessionCookie}=`));
		const anonymousPage =
			(request.method === "GET" || request.method === "HEAD") && path.startsWith("/p/") && !explicitCredential;
		// Restore clears and rebuilds grants. Wait before deciding whether an anonymous page is public.
		const pageAdmission = anonymousPage ? yield* child.traffic.requests.awaitDestination.pipe(Effect.result) : null;
		if (pageAdmission?._tag === "Failure") return authErrorResponse("boot_unavailable", 503);
		let publicPage: string | null = null;
		if (anonymousPage) {
			if ((yield* Ref.get(phase))._tag === "Ready") {
				const result = yield* publicPages.check(path).pipe(Effect.result);
				if (result._tag === "Failure") return authErrorResponse("boot_unavailable", 503);
				publicPage = result.success;
			}
		}
		const configuredPublic =
			!explicitCredential &&
			(request.method === "GET" || request.method === "HEAD") &&
			(yield* auth.publicPaths).includes(path);
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
				publicPage !== null ||
				configuredPublic);
		return yield* authFailure(
			Effect.gen(function* () {
				let identity = !isPublic || explicitCredential ? yield* authenticate(auth, request) : null;
				if (observed) yield* observed.attribute(identity, 0);
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
				if (identity) {
					const edited = yield* editRoute(
						{ ...editing, writable: (yield* Ref.get(phase))._tag === "Ready" },
						auth,
						identity,
						child.metrics,
						restores,
					);
					if (edited) return expires(edited);
				}
				const eventResponse = yield* eventRoute(
					events,
					child.attempts,
					identity,
					child.channelGate,
					child.traffic.route,
					authenticate(auth, request).pipe(
						Effect.map((current) => current.scopes.includes("read")),
						Effect.orElseSucceed(() => false),
					),
				);
				if (eventResponse) return expires(eventResponse);
				if (
					["/_boot/status", "/_boot/metrics", "/_boot/generations", "/api/generations"].includes(path) &&
					identity?.kind !== "human" &&
					!identity?.scopes.includes("fs")
				)
					return yield* new AuthError({ code: "scope_required" });
				if (path === "/_boot/metrics") {
					if (request.method !== "GET")
						return expires(
							HttpServerResponse.empty({ status: 405, headers: { allow: "GET", "cache-control": "no-store" } }),
						);
					return expires(
						HttpServerResponse.text(yield* child.metrics.render((yield* child.traffic.state).queued), {
							contentType: "text/plain; version=0.0.4; charset=utf-8",
							headers: { "cache-control": "no-store" },
						}),
					);
				}
				let destination = yield* Ref.get(child.traffic.route);
				const state = yield* Ref.get(child.status);
				const safeState = { ...state, stderr: redactHex(state.stderr) };
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
								hint: "GET /_boot/status and /_boot/generations for diagnostics. Open /_boot/recovery for human source undo. GET /_boot explains local recovery.",
								retriable: true,
							},
							...(identity?.kind === "human" || identity?.scopes.includes("fs")
								? { child: safeState, last_good: lastGood }
								: {}),
						},
						{ status: 503 },
					);
				const requestAdmission = pageAdmission ?? (yield* child.traffic.requests.awaitDestination.pipe(Effect.result));
				if (requestAdmission._tag === "Failure") return expires(unavailable());
				if (requestAdmission.success.waited && identity) identity = yield* authenticate(auth, request);
				if (publicPage !== null && !identity) {
					// Admission can wait across a database replacement. Recheck its current grants under the request lease.
					const checked = yield* (
						(yield* Ref.get(phase))._tag === "Ready" ? publicPages.check(path) : Effect.succeed(null)
					).pipe(Effect.result);
					if (checked._tag === "Failure") return authErrorResponse("boot_unavailable", 503);
					publicPage = checked.success;
					if (publicPage === null) return authErrorResponse("credential_required", 401);
				}
				if (configuredPublic && !identity && !(yield* auth.publicPaths).includes(path))
					return authErrorResponse("credential_required", 401);
				destination = requestAdmission.success.destination;
				if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
					const admitted = yield* child.traffic.awaitDestination;
					destination = admitted.destination;
					if (admitted.waited) identity = yield* authenticate(auth, request);
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
							![
								"host",
								"authorization",
								"cookie",
								"x-boot-secret",
								"forwarded",
								"content-length",
								"traceparent",
								"tracestate",
								"baggage",
							].includes(name),
					),
				);
				if (observed) yield* observed.attribute(identity, destination.generation);
				let outgoing = HttpClientRequest.make(request.method)(
					`http://127.0.0.1:${destination?.port}${path}${url.search}`,
					{
						headers: {
							...headers,
							...(path === "/api" || path === "/.well-known/agent.json" ? { "accept-encoding": "identity" } : {}),
							...(request.headers["x-comms-init"] && /^[a-f0-9]{64}$/.test(request.headers["x-comms-init"])
								? { "x-comms-init": request.headers["x-comms-init"] }
								: {}),
							...(publicPage !== null && !identity ? { "x-comms-public-page": publicPage } : {}),
							"x-boot-secret": destination.secret,
							"x-comms-request-id": requestId,
							...(observed ? { "x-comms-traceparent": observed.trace } : {}),
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

				return yield* client.execute(outgoing).pipe(
					Effect.flatMap((response) =>
						Effect.gen(function* () {
							if (observed) yield* observed.child(response.headers["x-comms-span"]);
							const discovered = yield* discoveryResponse(path, request.method, response);
							if (discovered) return discovered;
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
							let body = converted.body.stream;
							const credential = identity;
							if (credential && responseHeaders["content-type"]?.split(";")[0]?.trim() === "text/event-stream") {
								// Authentication remains at the credential boundary even when the app owns the stream.
								body = body.pipe(
									Stream.takeWhileEffect(() =>
										authenticate(auth, request).pipe(
											Effect.map((current) => current.scopes.includes("read")),
											Effect.timeout("2 seconds"),
											Effect.orElseSucceed(() => false),
										),
									),
									Stream.interruptWhen(
										Effect.gen(function* () {
											yield* Effect.sleep(Math.max(0, credential.expiresAt - (yield* Clock.currentTimeMillis)));
										}),
									),
								);
							}
							const forwarded = HttpServerResponse.empty({
								status: response.status,
								cookies: connection.has("set-cookie") ? Cookies.empty : Cookies.remove(response.cookies, sessionCookie),
							}).pipe(
								HttpServerResponse.setBody(HttpBody.stream(body, responseHeaders["content-type"] ?? "")),
								HttpServerResponse.setHeaders(responseHeaders),
							);
							return responseHeaders["content-type"] === undefined
								? HttpServerResponse.removeHeader(forwarded, "content-type")
								: forwarded;
						}),
					),
					Effect.orElseSucceed(unavailable),
					Effect.map(expires),
				);
			}),
		);
	}).pipe(Effect.tap((response) => (observed ? observed.status(response.status) : Effect.void)));
	return yield* observed ? routed.pipe(Effect.withParentSpan(observed.span)) : routed;
});

/** Immutable liveness/help and control-path exclusion work before the store can open. */
export const publicRoute = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const path = new URL(request.url, "http://localhost").pathname;
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
	return null;
});
