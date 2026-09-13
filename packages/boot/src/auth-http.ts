import { assertionHeader, requestIdHeader, tokenExpiresHeader } from "@comms/protocol/headers";
import { humanAgent } from "./human-agent.ts";
import { bootRoute } from "./boot-route.ts";
import { requestBytes } from "./request-bytes.ts";
import { childErrorPolicy } from "./child-error-policy.ts";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { ChildError } from "./child-process.ts";
import { TrafficError } from "./traffic.ts";
import { Cause, Console, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth, type AuthConfig } from "./auth.ts";
import { configuredParties, validRelyingParty } from "./auth-origins.ts";
import { PasskeyRegistrationResponse } from "./passkey-management-schema.ts";
import { authClient, authPage } from "./auth-page.ts";

export const sessionCookie = "__Host-comms_session";

const credential = Object.freeze({
	id: Schema.String,
	rawId: Schema.String,
	type: Schema.Literal("public-key"),
	clientExtensionResults: Schema.JsonObject,
});
const registration = Schema.Struct({ id: Schema.String, response: PasskeyRegistrationResponse });
export const authentication = Schema.Struct({
	id: Schema.String,
	response: Schema.Struct({
		...credential,
		response: Schema.Struct({
			clientDataJSON: Schema.String,
			authenticatorData: Schema.String,
			signature: Schema.String,
			userHandle: Schema.optionalKey(Schema.String),
		}),
	}),
});

const policy = {
	...childErrorPolicy,
	settings_conflict: {
		status: 409,
		hint: "Read GET /_boot/settings, then obtain a fresh settings.change assertion for the current revision and intended patch.",
	},
	already_collected: { status: 410, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	assertion_invalid: {
		status: 401,
		hint: "Obtain a fresh action challenge and sign the exact requested parameters with your passkey.",
	},
	auth_configuration_invalid: {
		status: 401,
		hint: "Correct RP_ID and PUBLIC_ORIGIN, or PUBLIC_ORIGINS, in the boot configuration before authenticating.",
	},
	authentication_failed: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	authentication_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	backup_not_found: { status: 404, hint: "Inspect /_boot/db/backups and select an existing backup." },
	backup_not_restorable: {
		status: 409,
		hint: "Select a backup with retained restore metadata; inspect the catalog before requesting another proof.",
	},
	challenge_invalid: {
		status: 401,
		hint: "Obtain a fresh challenge for this exact action; challenges expire and are single-use.",
	},
	device_secret_invalid: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	enrollment_decided: {
		status: 409,
		hint: "Inspect the enrollment decision; start a new enrollment if different scopes or approval are needed.",
	},
	enrollment_denied: { status: 403, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	enrollment_expired: { status: 410, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	enrollment_invalid: { status: 404, hint: "Start a new enrollment and use its returned identifier." },
	family_not_found: { status: 404, hint: "Inspect /_boot/tokens and select an existing token family." },
	family_revoked: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	generation_not_restorable: {
		status: 409,
		hint: "Inspect /_boot/generations and choose a generation with its retained snapshot and backup.",
	},
	idempotency_conflict: {
		status: 409,
		hint: "Keep the original request and Idempotency-Key together; use a new key only for a new operation.",
	},
	invalid_request: {
		status: 400,
		hint: "Correct the JSON body and query using the documented authentication operation. New enrollment hosts and token labels must be 1–64 lowercase letters, digits, dot, underscore or hyphen, starting with a letter or digit.",
	},
	last_passkey: { status: 409, hint: "Register another passkey before deleting the last registered key." },
	origin_has_passkeys: {
		status: 409,
		hint: "Delete the passkeys bound to this origin's RP ID first; inspect /_boot/auth/passkeys.",
	},
	origin_invalid: {
		status: 403,
		hint: "Send this action from a configured or activated origin with its exact Origin header; a code bound to an origin redeems only there. Inspect /_boot/auth/origins.",
	},
	origin_last_passkey: {
		status: 409,
		hint: "Keep at least one passkey for each configured origin's RP ID. Add another passkey on that address before deleting this one.",
	},
	origin_not_found: { status: 404, hint: "Inspect /_boot/auth/origins and select an activated runtime origin." },
	origin_protected: {
		status: 409,
		hint: "Configured origins and the origin this request came from cannot be removed. Remove it from another origin.",
	},
	origin_unproven: {
		status: 403,
		hint: "The board could not fetch its one-time proof from that domain. Point the domain at this board first, for example by adding it in Railway and creating the DNS record, then enter the code again.",
	},
	passkey_origin_mismatch: {
		status: 409,
		hint: "No stored passkey belongs to an address this board serves, so nobody can sign in. The operator can restore the previous RP_ID/PUBLIC_ORIGIN or PUBLIC_ORIGINS, set REOPEN_SETUP=1 and open /setup with the code from the boot log, or empty boot's passkey table (DELETE FROM passkeys).",
	},
	passkey_code_locked: {
		status: 429,
		hint: "Too many wrong codes. Wait for the lockout to end, then enter the code again before it expires.",
	},
	passkey_code_invalid: {
		status: 401,
		hint: "Ask the signed-in human for a new add-passkey code; codes look like 12 hex characters, a dash and 16 more, expire, are single-use, and redeem only on their bound address. Three wrong secrets for a code lock its redemption briefly.",
	},
	passkey_exists: { status: 409, hint: "Use the registered passkey or choose a different authenticator." },
	passkey_not_found: { status: 404, hint: "Inspect /_boot/auth/passkeys and select an existing passkey." },
	refresh_invalid: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	registration_failed: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	registration_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	restore_in_progress: {
		status: 409,
		hint: "Inspect /_boot/status and finish the existing restore before starting another one.",
	},
	scope_required: {
		status: 403,
		hint: "Re-enroll with POST /auth/enroll and ask the human to grant the required scope.",
	},
	session_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	setup_closed: { status: 404, hint: "Setup is complete. Sign in at /auth/login with an existing passkey." },
	setup_code_invalid: { status: 401, hint: "Use the current setup code printed by boot; do not reuse an older code." },
	setup_required: { status: 401, hint: "Complete first-passkey setup at /setup using the code printed by boot." },
	token_expired: { status: 401, hint: "POST /auth/refresh with your refresh token." },
	token_invalid: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	boot_unavailable: { status: 503, hint: "Retry the same request; check bootloader logs if it persists." },
	credential_required: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	handler_failed: { status: 500, hint: "Inspect bootloader logs. This failure is not an unchanged-retry condition." },
} as const satisfies Readonly<
	Record<
		AuthError["code"] | ChildError["code"] | "boot_unavailable" | "credential_required" | "handler_failed",
		{ readonly status: number; readonly hint: string }
	>
>;
export const authErrorResponse = (
	code: keyof typeof policy,
	status: number = policy[code].status,
	route = "the requested route",
) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message:
					status === 503
						? "Boot authentication is unavailable."
						: status === 500
							? `Handler failed for ${route}.`
							: "Authentication request refused.",
				hint: policy[code].hint,
				retriable: status === 503,
			},
		},
		{ status, headers: { "cache-control": "no-store" } },
	);

/** Browser navigations belong on the login page, not on a JSON refusal. API clients keep the JSON 401. */
const pageNavigation = (request: HttpServerRequest.HttpServerRequest) =>
	(request.method === "GET" || request.method === "HEAD") && (request.headers.accept ?? "").includes("text/html");

const loginRedirect = (request: HttpServerRequest.HttpServerRequest) => {
	const target = request.url.startsWith("/") && !request.url.startsWith("//") ? request.url : "/";
	return HttpServerResponse.empty({
		status: 302,
		headers: { location: `/auth/login?next=${encodeURIComponent(target)}`, "cache-control": "no-store" },
	});
};

export const authFailure = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause))
				return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));
			// Classify the complete cause before extracting a typed refusal: finalizer defects must not become 401/503.
			const expected =
				cause.reasons.length === 1 &&
				cause.reasons.every(
					(reason) =>
						reason._tag === "Fail" &&
						(Schema.is(AuthError)(reason.error) ||
							Schema.is(ChildError)(reason.error) ||
							Schema.is(TrafficError)(reason.error) ||
							Cause.isTimeoutError(reason.error) ||
							(isSqlError(reason.error) && reason.error.isRetryable)),
				);
			if (!expected)
				return Effect.gen(function* () {
					const request = Option.getOrUndefined(yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest));
					return authErrorResponse(
						"handler_failed",
						500,
						request ? `${request.method} ${request.url.split("?")[0]}` : undefined,
					);
				});
			const refusal = cause.reasons.find(
				(reason) =>
					reason._tag === "Fail" && (Schema.is(AuthError)(reason.error) || Schema.is(ChildError)(reason.error)),
			);
			return Effect.gen(function* () {
				const request = Option.getOrUndefined(yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest));
				if (
					request &&
					refusal?._tag === "Fail" &&
					Schema.is(AuthError)(refusal.error) &&
					policy[refusal.error.code].status === 401 &&
					pageNavigation(request)
				)
					return loginRedirect(request);
				return refusal?._tag === "Fail" && (Schema.is(AuthError)(refusal.error) || Schema.is(ChildError)(refusal.error))
					? authErrorResponse(refusal.error.code)
					: authErrorResponse("boot_unavailable");
			});
		}),
	);

/** Every configured origin must pass the relying-party rules, and no origin may be listed twice. */
export const validateAuthConfig = (config: AuthConfig) => {
	const parties = configuredParties(config);
	return parties.every(validRelyingParty) &&
		new Set(parties.map((party) => party.expectedOrigin)).size === parties.length
		? Effect.void
		: Effect.fail(new AuthError({ code: "auth_configuration_invalid" }));
};

// The Bun fetch adapter does not enforce HttpIncomingMessage.MaxBodySize on JSON bodies.
export const body = <A>(schema: Schema.ConstraintDecoder<A>) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const bytes = yield* requestBytes(request, 64 * 1024, new AuthError({ code: "invalid_request" }));
		return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(bytes.toString("utf8"), {
			onExcessProperty: "error",
		});
	}).pipe(
		Effect.timeout("5 seconds"),
		Effect.mapError(() => new AuthError({ code: "invalid_request" })),
	);

export const sessionToken = (request: HttpServerRequest.HttpServerRequest) => {
	const values = (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${sessionCookie}=`));
	if (values.length !== 1) return null;
	const value = values[0]?.slice(sessionCookie.length + 1);
	return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};

/** A successful passkey sign-in or code redemption issues the human session cookie. */
export const sessionResponse = (session: { readonly token: string; readonly expiresAt: number }) =>
	HttpServerResponse.jsonUnsafe(
		{ expires_at: session.expiresAt },
		{ headers: { [tokenExpiresHeader]: String(session.expiresAt) } },
	).pipe(
		HttpServerResponse.setCookieUnsafe(sessionCookie, session.token, {
			httpOnly: true,
			secure: true,
			sameSite: "strict",
			path: "/",
			maxAge: 30 * 24 * 60 * 60,
		}),
	);

export const pageHeaders = Object.freeze({
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
});

export const authenticate = (auth: Auth["Service"], request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const authorization = request.headers.authorization;
		if (authorization !== undefined) {
			const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
			if (!token) return yield* new AuthError({ code: "token_invalid" });
			return yield* auth.authenticateAccess(token);
		}
		const token = sessionToken(request);
		if (!token) return yield* new AuthError({ code: "session_invalid" });
		const session = yield* auth.authenticateSession(token);
		return { ...session, kind: "human" as const, agent: humanAgent, label: "human", scopes: ["read", "write", "fs"] };
	});

export const humanSession = (auth: Auth["Service"], request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		if (request.headers.authorization !== undefined) return yield* new AuthError({ code: "session_invalid" });
		const token = sessionToken(request);
		if (!token) return yield* new AuthError({ code: "session_invalid" });
		return yield* auth.authenticateSession(token);
	});

export const assertionProof = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const header = request.headers[assertionHeader];
		if (!header || header.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(header))
			return yield* new AuthError({ code: "assertion_invalid" });
		return yield* Schema.decodeEffect(Schema.fromJsonString(authentication))(
			Buffer.from(header, "base64url").toString("utf8"),
			{ onExcessProperty: "error" },
		).pipe(Effect.mapError(() => new AuthError({ code: "assertion_invalid" })));
	});

/** Exact boot-owned entry points; other /auth and /_boot paths remain private. */
export const authRoute = (auth: Auth["Service"], requestId: string) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const path = url.pathname;
		if (request.method === "GET" && path === "/_boot/auth/client.js")
			return HttpServerResponse.text(authClient, {
				contentType: "text/javascript",
				headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
			});
		const page = request.method === "GET" && (path === "/setup" || path === "/auth/login");
		const post =
			request.method === "POST" &&
			[
				"/_boot/auth/setup/options",
				"/_boot/auth/setup/verify",
				"/_boot/auth/login/options",
				"/_boot/auth/login/verify",
				"/_boot/auth/logout",
			].includes(path);
		if (!page && !post) return null;
		if (post) yield* Console.error(`boot.auth stage=request method=POST path=${path} request_id=${requestId}`);
		return yield* authFailure(
			Effect.gen(function* () {
				if (page) {
					const setupOpen = yield* auth.setupOpen;
					if (path === "/auth/login" && (yield* auth.setupRequired)) {
						const next = url.searchParams.get("next");
						return HttpServerResponse.empty({
							status: 302,
							headers: {
								location: `/setup${next === null ? "" : `?next=${encodeURIComponent(next)}`}`,
								"cache-control": "no-store",
							},
						});
					}
					if (path === "/setup" && !setupOpen)
						return HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } });
					return HttpServerResponse.text(authPage(path === "/setup" ? "setup" : "login"), {
						contentType: "text/html",
						headers: pageHeaders,
					});
				}
				const party = yield* auth.relyingParty(request.headers.origin);
				const ceremonies = auth.at(party);
				if (path === "/_boot/auth/setup/options") {
					const input = yield* body(Schema.Struct({ code: Schema.String }));
					return HttpServerResponse.jsonUnsafe(yield* ceremonies.startSetup(input.code));
				}
				if (path === "/_boot/auth/setup/verify") {
					const input = yield* body(registration);
					return HttpServerResponse.jsonUnsafe(yield* ceremonies.finishSetup(input.id, input.response));
				}
				if (path === "/_boot/auth/login/options") {
					yield* body(Schema.Struct({}));
					return HttpServerResponse.jsonUnsafe(yield* ceremonies.startLogin);
				}
				if (path === "/_boot/auth/login/verify") {
					const input = yield* body(authentication);
					return sessionResponse(yield* ceremonies.finishLogin(input.id, input.response));
				}
				if (request.headers.authorization !== undefined) return yield* new AuthError({ code: "session_invalid" });
				yield* authenticate(auth, request);
				const token = sessionToken(request);
				if (!token) return yield* new AuthError({ code: "session_invalid" });
				yield* auth.logout(token);
				return HttpServerResponse.empty({ status: 204 }).pipe(
					HttpServerResponse.setCookieUnsafe(sessionCookie, "", {
						httpOnly: true,
						secure: true,
						sameSite: "strict",
						path: "/",
						maxAge: 0,
					}),
				);
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		).pipe(
			Effect.map(HttpServerResponse.setHeader(requestIdHeader, requestId)),
			Effect.tap((response) =>
				post
					? Console.error(
							`boot.auth stage=response method=POST path=${path} status=${response.status} request_id=${requestId}`,
						)
					: Effect.void,
			),
		);
	});
