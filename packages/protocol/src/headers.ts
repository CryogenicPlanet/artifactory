/**
 * The one place the Chirp HTTP header family is spelled out. Every producer and every consumer,
 * in source and in tests, reads a name from here, so renaming the family is an edit to this file
 * rather than to three hundred call sites. The rename from `x-comms-*` touched 99 files; the next
 * one should touch this one.
 *
 * This module is deliberately a leaf. It imports nothing, not even Effect, so any package can
 * depend on it for the cost of a string table and no import cycle can form through it.
 *
 * Names are lowercase because that is how both Effect's server request headers and Node's
 * incoming headers are normalised, so a lowercase constant can be compared directly against a
 * received name. Use `headerLabel` where prose wants the canonical mixed-case spelling.
 */

/**
 * The family prefix. Two boundaries match on this rather than on a full name, and both are
 * security-relevant, so the prefix is exported instead of being rebuilt from a literal at each
 * site: boot's proxy strips every inbound `x-chirp-*` header so a client cannot forge an identity,
 * and the server refuses child-control requests that carry one. A prefix check left behind by a
 * rename fails open and silently.
 */
export const headerPrefix = "x-chirp-";

/** Identity boot injects after authenticating, and the app reads. Never accepted from a client. */
export const agentHeader = "x-chirp-agent";
export const authKindHeader = "x-chirp-auth-kind";
export const instanceHeader = "x-chirp-instance";
export const labelHeader = "x-chirp-label";
export const scopesHeader = "x-chirp-scopes";
export const requestIdHeader = "x-chirp-request-id";
export const tokenExpiresHeader = "x-chirp-token-expires";

/** The WebAuthn assertion the browser sends to bind a sensitive action to a fresh ceremony. */
export const assertionHeader = "x-chirp-assertion";

/** Onboarding instruction freshness: the app stamps the version, the agent echoes it back. */
export const initHeader = "x-chirp-init";
export const initVersionHeader = "x-chirp-init-version";
export const initStaleHeader = "x-chirp-init-stale";

/** Boot-to-child control and health, on the private loopback surface. */
export const writerEpochHeader = "x-chirp-writer-epoch";
export const kernelProtocolHeader = "x-chirp-kernel-protocol";
export const healthReadyHeader = "x-chirp-health-ready";
export const readinessHeader = "x-chirp-readiness";
export const rehearsalReportHeader = "x-chirp-rehearsal-report";

/** Editing and page serving. */
export const baseVersionHeader = "x-chirp-base-version";
export const publicPageHeader = "x-chirp-public-page";
export const pageRevisionHeader = "x-chirp-page-revision";

/** Tracing, and the delivery identity a webhook recipient uses to deduplicate retries. */
export const traceparentHeader = "x-chirp-traceparent";
export const spanHeader = "x-chirp-span";
export const deliveryIdHeader = "x-chirp-delivery-id";

/**
 * OpenAPI specification extensions, not HTTP headers. An OpenAPI extension key must begin with
 * `x-`, which puts these in the same namespace as the header family whether or not that was
 * intended, so they are renamed with it and live here for the same reason. `scopesHeader` does
 * double duty: boot's manifest and the app's spec publish the required scopes under the same name
 * the identity header carries them in.
 */
export const authExtension = "x-chirp-auth";

/**
 * The canonical mixed-case spelling of a header name, for prose that names a header to a human or
 * to an agent reading the manifest. Derived rather than declared so the two spellings cannot drift
 * apart: `x-chirp-base-version` becomes `X-Chirp-Base-Version`.
 */
export const headerLabel = (name: string): string =>
	name
		.split("-")
		.map((part) => (part === "" ? part : part[0]!.toUpperCase() + part.slice(1)))
		.join("-");
