import { Effect } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import type { Auth } from "./auth.ts";

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

/** The Origin header must exactly equal a configured or activated origin; a pending code origin is not one. */
export const checkBootOrigin = (
	operation: keyof typeof originPolicy,
	request: HttpServerRequest.HttpServerRequest,
	auth: Pick<Auth["Service"], "relyingParty">,
	kind: "human" | "agent" = "human",
) => {
	const policy = originPolicy[operation];
	return policy === "required" || (policy === "human" && kind === "human")
		? Effect.asVoid(auth.relyingParty(request.headers.origin))
		: Effect.void;
};
