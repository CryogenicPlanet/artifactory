import { Clock, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth, type AuthConfig } from "./auth.ts";
import { assertionProof, humanSession, authFailure, body } from "./auth-http.ts";
import { AddPasskey, DeletePasskey } from "./passkey-management-schema.ts";
import { MintBinding } from "./token-mint-schema.ts";
import { DatabaseRestoreInput, databaseRestoreParams, GenerationRestoreParams } from "./database-restore-schema.ts";
import { BreakLock } from "./lock-break-schema.ts";
import { RevokeFamily } from "./refresh-schema.ts";
import { EnrollmentDecision } from "./enrollment-schema.ts";
import { approvalClient, approvalPage } from "./enrollment-page.ts";

const challengeInput = Schema.Union([
	Schema.Struct({ action: Schema.Literal("generation.restore"), params: GenerationRestoreParams }),
	Schema.Struct({ action: Schema.Literal("boot.restart"), params: Schema.Record(Schema.String, Schema.Never) }),
	Schema.Struct({ action: Schema.Literal("db.restore"), params: DatabaseRestoreInput }),
	Schema.Struct({ action: Schema.Literal("passkey.add"), params: AddPasskey }),
	Schema.Struct({ action: Schema.Literal("passkey.delete"), params: DeletePasskey }),
	Schema.Struct({ action: Schema.Literal("token.mint"), params: MintBinding }),
	Schema.Struct({ action: Schema.Literal("enrollment.decide"), params: EnrollmentDecision }),
	Schema.Struct({ action: Schema.Literal("token.revoke"), params: RevokeFamily }),
	Schema.Struct({ action: Schema.Literal("lock.break"), params: BreakLock }),
]);
const decisionInput = Schema.Struct({
	decision: Schema.Literals(["approve", "deny"]),
	scopes: EnrollmentDecision.fields.scopes,
	long_lived: Schema.Boolean,
});
const pageHeaders = Object.freeze({
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
});
export const enrollmentRoute = (auth: Auth["Service"], config: AuthConfig) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://localhost"),
			path = url.pathname;
		const create = request.method === "POST" && ["/auth/enroll", "/_boot/enroll"].includes(path);
		const poll =
			request.method === "POST" ? /^\/(?:auth|_boot)\/enroll\/(e_[A-Za-z0-9_-]{43})$/.exec(path)?.[1] : undefined;
		const decide =
			request.method === "POST" ? /^\/_boot\/enroll\/(e_[A-Za-z0-9_-]{43})\/approve$/.exec(path)?.[1] : undefined;
		const page = request.method === "GET" ? /^\/(?:_boot\/)?approve\/(e_[A-Za-z0-9_-]{43})$/.exec(path) : null;
		const challenge = request.method === "POST" && path === "/_boot/auth/challenge";
		if (request.method === "GET" && path === "/_boot/auth/approval.js")
			return HttpServerResponse.text(approvalClient, { contentType: "text/javascript", headers: pageHeaders });
		if (!create && !poll && !decide && !page && !challenge) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const approveUrl = (id: string) => `${config.expectedOrigin}/approve/${id}`;
				if (page?.[1]) {
					const info = yield* auth.enrollmentInfo(page[1]);
					return HttpServerResponse.text(approvalPage(info), { contentType: "text/html", headers: pageHeaders });
				}
				if (create) {
					if (url.search) return yield* new AuthError({ code: "invalid_request" });
					const input = yield* body(Schema.Struct({ name: Schema.String, kind: Schema.String, host: Schema.String }));
					const result = yield* auth.createEnrollment(input);
					const link = approveUrl(result.id);
					return HttpServerResponse.jsonUnsafe({ ...result, approve_url: link });
				}
				if (poll) {
					if ([...url.searchParams.keys()].some((key) => key !== "wait") || url.searchParams.getAll("wait").length > 1)
						return yield* new AuthError({ code: "invalid_request" });
					const value = url.searchParams.get("wait"),
						wait = value === null ? 0 : Number(value);
					if (value === "" || !Number.isInteger(wait) || wait < 0 || wait > 60)
						return yield* new AuthError({ code: "invalid_request" });
					const input = yield* body(Schema.Struct({ device_secret: Schema.String }));
					const deadline = (yield* Clock.currentTimeMillis) + wait * 1000;
					while (true) {
						const result = yield* auth.collectEnrollment(poll, input.device_secret);
						if (result.status !== "pending" || (yield* Clock.currentTimeMillis) >= deadline)
							return HttpServerResponse.jsonUnsafe(result, { status: result.status === "pending" ? 202 : 200 });
						yield* Effect.sleep("100 millis");
					}
				}
				if (request.headers.origin !== config.expectedOrigin) return yield* new AuthError({ code: "origin_invalid" });
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (challenge) {
					const input = yield* body(challengeInput);
					if (input.action === "passkey.add" || input.action === "passkey.delete") {
						const session = yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(
							yield* input.action === "passkey.add"
								? auth.startPasskeyAddAssertion(input.params, session.id)
								: auth.startPasskeyDeleteAssertion(input.params, session.id),
						);
					}
					if (input.action === "generation.restore") {
						const session = yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(yield* auth.startGenerationRestoreAssertion(input.params, session.id));
					}
					if (input.action === "boot.restart") {
						const session = yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(yield* auth.startRestartAssertion(session.id));
					}
					if (input.action === "db.restore") {
						const session = yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(
							yield* auth.startDatabaseRestoreAssertion(databaseRestoreParams(input.params), session.id),
						);
					}
					if (input.action === "token.mint") {
						yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(yield* auth.startMintAssertion(input.params));
					}
					if (input.action === "lock.break") {
						yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(yield* auth.startLockBreakAssertion(input.params));
					}
					if (input.action === "token.revoke") {
						yield* humanSession(auth, request);
						return HttpServerResponse.jsonUnsafe(yield* auth.startRevocationAssertion(input.params));
					}
					return HttpServerResponse.jsonUnsafe(yield* auth.startEnrollmentAssertion(input.params));
				}
				if (decide) {
					const input = yield* body(decisionInput);
					const proof = yield* assertionProof(request);
					return HttpServerResponse.jsonUnsafe(yield* auth.decideEnrollment({ id: decide, ...input }, proof));
				}
				return HttpServerResponse.empty({ status: 404 });
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
