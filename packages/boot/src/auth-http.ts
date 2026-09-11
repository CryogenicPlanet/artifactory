import { isSqlError } from "effect/unstable/sql/SqlError";
import { ChildError } from "./child-process.ts";
import { TrafficError } from "./traffic.ts";
import { Cause, Effect, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth, type AuthConfig } from "./auth.ts";
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
	already_collected: { status: 410, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	assertion_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	auth_configuration_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	authentication_failed: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	authentication_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	backup_not_found: { status: 404, hint: "Use /setup for first setup or /auth/login to sign in." },
	backup_not_restorable: { status: 409, hint: "Use /setup for first setup or /auth/login to sign in." },
	challenge_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	device_secret_invalid: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	enrollment_decided: { status: 409, hint: "Use /setup for first setup or /auth/login to sign in." },
	enrollment_denied: { status: 403, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	enrollment_expired: { status: 410, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	enrollment_invalid: { status: 404, hint: "Use /setup for first setup or /auth/login to sign in." },
	family_not_found: { status: 404, hint: "Use /setup for first setup or /auth/login to sign in." },
	family_revoked: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	generation_not_restorable: { status: 409, hint: "Use /setup for first setup or /auth/login to sign in." },
	idempotency_conflict: { status: 409, hint: "Use a fresh Idempotency-Key for this refresh token." },
	invalid_request: { status: 400, hint: "Use /setup for first setup or /auth/login to sign in." },
	last_passkey: { status: 409, hint: "Use /setup for first setup or /auth/login to sign in." },
	origin_invalid: { status: 403, hint: "Use /setup for first setup or /auth/login to sign in." },
	passkey_exists: { status: 409, hint: "Use /setup for first setup or /auth/login to sign in." },
	passkey_not_found: { status: 404, hint: "Use /setup for first setup or /auth/login to sign in." },
	refresh_invalid: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	registration_failed: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	registration_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	restore_in_progress: { status: 409, hint: "Use /setup for first setup or /auth/login to sign in." },
	scope_required: {
		status: 403,
		hint: "Re-enroll with POST /auth/enroll and ask the human to grant the required scope.",
	},
	session_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	setup_closed: { status: 404, hint: "Use /setup for first setup or /auth/login to sign in." },
	setup_code_invalid: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	setup_required: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	token_expired: { status: 401, hint: "POST /auth/refresh with your refresh token." },
	token_invalid: { status: 401, hint: "Re-enroll with POST /auth/enroll. Collection is one-time." },
	boot_unavailable: { status: 503, hint: "Retry the same request; check bootloader logs if it persists." },
	credential_required: { status: 401, hint: "Use /setup for first setup or /auth/login to sign in." },
	handler_failed: { status: 500, hint: "Inspect bootloader logs. This failure is not an unchanged-retry condition." },
} as const satisfies Readonly<
	Record<
		AuthError["code"] | "boot_unavailable" | "credential_required" | "handler_failed",
		{ readonly status: number; readonly hint: string }
	>
>;
export const authErrorResponse = (code: keyof typeof policy, status: number = policy[code].status) =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				code,
				message:
					status === 503
						? "Boot authentication is unavailable."
						: status === 500
							? "Boot handler failed."
							: "Authentication request refused.",
				hint: policy[code].hint,
				retriable: status === 503,
			},
		},
		{ status, headers: { "cache-control": "no-store" } },
	);

export const authFailure = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause))
				return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));
			// Classify the complete cause before extracting a typed refusal: finalizer defects must not become 401/503.
			const expected =
				cause.reasons.length > 0 &&
				cause.reasons.every(
					(reason) =>
						reason._tag === "Fail" &&
						(Schema.is(AuthError)(reason.error) ||
							Schema.is(ChildError)(reason.error) ||
							Schema.is(TrafficError)(reason.error) ||
							Cause.isTimeoutError(reason.error) ||
							(isSqlError(reason.error) && reason.error.isRetryable)),
				);
			if (!expected) return Effect.succeed(authErrorResponse("handler_failed"));
			const refusal = cause.reasons.find((reason) => reason._tag === "Fail" && Schema.is(AuthError)(reason.error));
			return Effect.succeed(
				refusal?._tag === "Fail" && Schema.is(AuthError)(refusal.error)
					? authErrorResponse(refusal.error.code)
					: authErrorResponse("boot_unavailable"),
			);
		}),
	);

export const validateAuthConfig = (config: AuthConfig) =>
	Effect.try({
		try: () => {
			const origin = new URL(config.expectedOrigin);
			const rp = new URL(`https://${config.rpId}`);
			if (
				origin.origin !== config.expectedOrigin ||
				origin.username ||
				origin.password ||
				rp.hostname !== config.rpId ||
				rp.port ||
				rp.pathname !== "/" ||
				!(origin.hostname === config.rpId || origin.hostname.endsWith(`.${config.rpId}`)) ||
				!(origin.protocol === "https:" || (origin.protocol === "http:" && origin.hostname === "localhost"))
			)
				throw new Error("Invalid relying party or public origin");
		},
		catch: () => new AuthError({ code: "auth_configuration_invalid" }),
	});

// The Bun fetch adapter does not enforce HttpIncomingMessage.MaxBodySize on JSON bodies.
export const body = <A>(schema: Schema.ConstraintDecoder<A>) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		let size = 0;
		const chunks: Uint8Array[] = [];
		yield* Stream.runForEach(request.stream, (chunk) =>
			Effect.gen(function* () {
				size += chunk.byteLength;
				if (size > 64 * 1024) return yield* new AuthError({ code: "invalid_request" });
				chunks.push(chunk);
			}),
		);
		return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(Buffer.concat(chunks).toString("utf8"), {
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
		return { ...session, kind: "human" as const, agent: "rahul", label: "human", scopes: ["read", "write", "fs"] };
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
		const header = request.headers["x-comms-assertion"];
		if (!header || header.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(header))
			return yield* new AuthError({ code: "assertion_invalid" });
		return yield* Schema.decodeEffect(Schema.fromJsonString(authentication))(
			Buffer.from(header, "base64url").toString("utf8"),
			{ onExcessProperty: "error" },
		).pipe(Effect.mapError(() => new AuthError({ code: "assertion_invalid" })));
	});

/** Exact boot-owned entry points; other /auth and /_boot paths remain private. */
export const authRoute = (auth: Auth["Service"], config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const path = new URL(request.url, "http://localhost").pathname;
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
		return yield* authFailure(
			Effect.gen(function* () {
				if (page) {
					if (path === "/setup" && !(yield* auth.setupOpen))
						return HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } });
					return HttpServerResponse.text(authPage(path === "/setup"), {
						contentType: "text/html",
						headers: {
							"cache-control": "no-store",
							"content-security-policy":
								"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
							"x-content-type-options": "nosniff",
							"referrer-policy": "no-referrer",
						},
					});
				}
				if (request.headers.origin !== config.expectedOrigin) return yield* new AuthError({ code: "origin_invalid" });
				if (path === "/_boot/auth/setup/options") {
					const input = yield* body(Schema.Struct({ code: Schema.String }));
					return HttpServerResponse.jsonUnsafe(yield* auth.startSetup(input.code));
				}
				if (path === "/_boot/auth/setup/verify") {
					const input = yield* body(registration);
					return HttpServerResponse.jsonUnsafe(yield* auth.finishSetup(input.id, input.response));
				}
				if (path === "/_boot/auth/login/options") {
					yield* body(Schema.Struct({}));
					return HttpServerResponse.jsonUnsafe(yield* auth.startLogin);
				}
				if (path === "/_boot/auth/login/verify") {
					const input = yield* body(authentication);
					const session = yield* auth.finishLogin(input.id, input.response);
					return HttpServerResponse.jsonUnsafe(
						{ expires_at: session.expiresAt },
						{ headers: { "x-comms-token-expires": String(session.expiresAt) } },
					).pipe(
						HttpServerResponse.setCookieUnsafe(sessionCookie, session.token, {
							httpOnly: true,
							secure: true,
							sameSite: "strict",
							path: "/",
							maxAge: 30 * 24 * 60 * 60,
						}),
					);
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
		);
	});
