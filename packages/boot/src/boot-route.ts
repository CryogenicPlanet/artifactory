import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { AuthError, type AuthConfig } from "./auth.ts";

/** Capture the request without introducing a scope: response finalizers belong to the HTTP adapter. */
export const bootRoute = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	return { request, url: new URL(request.url, "http://localhost") };
});

// Public secret exchanges and human metadata reads are exempt. Checks stay at each route's
// existing authorization boundary; backup repeats its human-only check after queue admission.
const originPolicy = {
	passkeyRead: "none",
	authWrite: "required",
	passkeyWrite: "required",
	tokenMint: "required",
	tokenRevoke: "required",
	enrollmentHuman: "required",
	backupWrite: "human",
	databaseRestore: "required",
	restart: "required",
	settingsWrite: "required",
} as const;

export const checkBootOrigin = (
	operation: keyof typeof originPolicy,
	request: HttpServerRequest.HttpServerRequest,
	config: AuthConfig,
	kind: "human" | "agent" = "human",
) => {
	const policy = originPolicy[operation];
	return (policy === "required" || (policy === "human" && kind === "human")) &&
		request.headers.origin !== config.expectedOrigin
		? Effect.fail(new AuthError({ code: "origin_invalid" }))
		: Effect.void;
};
