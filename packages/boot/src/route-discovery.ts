import type { Schema } from "effect";

type Access = "public" | "read" | "fs" | "human" | "proof" | "device-secret" | "refresh-token" | "action-dependent";
// Immutable descriptors live beside the handlers that own these routes. Private child IPC is intentionally excluded.
const routes = [
	[
		"get",
		["/_boot/settings"],
		"human",
		"Read revisioned storage percentages and additional exact public GET/HEAD paths. Internal settings and recovery receipts are never exposed.",
	],
	[
		"post",
		["/_boot/settings"],
		"human",
		"Change {revision,patch} with exact Origin and a fresh settings.change X-Chirp-Assertion bound to that body and session. patch may contain storage or public_paths. Calendar retention is retired: new event_retention changes are refused with invalid_request; only previously accepted exact signed retries remain readable. Repeat the exact proof and body after a lost response to read the first accepted result; it never reapplies over a later change.",
	],
	["get", ["/health"], "public", "Bootloader liveness, independent of the app."],
	["head", ["/health"], "public", "Bootloader liveness without a response body."],
	["get", ["/_boot"], "public", "Plain-text boot recovery help."],
	[
		"get",
		["/.well-known/agent.json"],
		"public",
		"Immutable boot recovery manifest. Follow api_url for the full live application route table.",
	],
	[
		"get",
		["/_boot/recovery"],
		"human",
		"Immutable source-undo confirmation page; remains available when the app and its board cannot run.",
	],
	[
		"get",
		["/_boot/status"],
		"fs",
		"Child state, recovery diagnostics and traffic state. Human session or fs-scoped bearer.",
	],
	[
		"get",
		["/_boot/generations", "/api/generations"],
		"fs",
		"Retained generation history and last good generation. Human session or fs-scoped bearer.",
	],
	[
		"post",
		["/_boot/restart"],
		"human",
		"Restart boot with strict {}, exact Origin and a fresh boot.restart X-Chirp-Assertion bound to params {}. Returns 202 {status:restarting}, then exits gracefully for the external supervisor to relaunch. A lost response is uncertain; no idempotency replay.",
	],
	[
		"post",
		["/_boot/reset"],
		"human",
		"Reset source to the captured image seed with strict {}, no query parameters, exact Origin and a fresh app.reset X-Chirp-Assertion from params {} bound to that seed and session. Rehearses and cuts over; preserves messages, pages and identities. Returns {generation,status,lock,error?,stderr?}; a lost response is uncertain and the proof is single-use.",
	],
	["get", ["/_boot/db/backups"], "human", "List retained app database backups; optional limit and before cursor."],
	[
		"post",
		["/_boot/db/backup"],
		"fs",
		"Capture a consistent app database backup. Send {}. Human session with Origin or fs-scoped bearer. An uncertain failure requires inspecting the backup catalog before retrying.",
	],
	[
		"post",
		["/_boot/db/restore"],
		"human",
		"Restore {backup} (or {id}) with exact Origin and a fresh db.restore X-Chirp-Assertion. Optional Idempotency-Key binds retries.",
	],
	[
		"get",
		["/_boot/fs/{path}", "/api/fs/{path}"],
		"fs",
		"Read app/ or pages/ source, browse a directory, or list file versions with ?history. path may contain slashes. Raw files return ETag for conditional writes.",
	],
	[
		"put",
		["/_boot/fs/{path}", "/api/fs/{path}"],
		"fs",
		"Write raw source bytes with required ?baseVersion=<SHA-256 from GET>, or baseVersion=null for a new file. Single If-Match: quoted ETag or If-None-Match: * aliases are accepted instead. Missing/combined/invalid conditions return 400; stale bytes return 409 stale_base. app/ requires your edit lock; ?reload=0 stages, ?check=1 rehearses, ?release=1 releases after success. pages/ publishes without the app lock.",
	],
	[
		"delete",
		["/_boot/fs/{path}", "/api/fs/{path}"],
		"fs",
		"Delete source. Optional If-Match: quoted SHA-256 ETag or If-None-Match: *; mismatch returns 409 stale_base. app/ requires your edit lock and follows reload semantics; pages/ publishes directly.",
	],
	["get", ["/_boot/lock", "/api/lock"], "fs", "Inspect the current source edit lock."],
	[
		"post",
		["/_boot/lock", "/api/lock"],
		"fs",
		"Acquire the source edit lock with JSON {ttl?,note?}, or {}. A competing holder returns 423.",
	],
	[
		"delete",
		["/_boot/lock", "/api/lock"],
		"fs",
		"Release your edit lock. ?break=1 instead requires a human session and fresh lock.break X-Chirp-Assertion bound to the observed lock.",
	],
	[
		"post",
		["/_boot/reload", "/api/reload"],
		"fs",
		"Rehearse and publish your locked source overlay. Send {}. ?check=1 checks only; ?release=1 releases after successful cutover.",
	],
	[
		"post",
		["/_boot/revert", "/api/revert"],
		"fs",
		"Restore source with {} or one selector {path}, {batch}, {version}, {generation}. App undo requires your lock and empty staging. Optional Idempotency-Key. For {generation,withDb:true}, a human session, exact Origin and fresh generation.restore X-Chirp-Assertion bound to the exact generation, backup and optional Idempotency-Key are required; restores both source and that backup.",
	],
	[
		"get",
		["/_boot/events"],
		"read",
		"Read bounded boot recovery diagnostics and boot-written request records while the app is unavailable. Agents see only their own request records; humans see all. Read scope; private current failure detail additionally requires human or fs authority. Optional since (exclusive), limit (1–200) and wait (0–60 seconds); defaults to the latest 100 events. Diagnostic cursors are not application event cursors; pending app publication cannot hide boot failures. Application event browsing belongs to /api/events.",
	],
	[
		"post",
		["/_boot/enroll", "/auth/enroll"],
		"public",
		"Start enrollment with {name,kind,host}; host must be lowercase. Returns id, device_secret, user_code, approve_url and expires_at. Collection is one-time.",
	],
	[
		"post",
		["/_boot/enroll/{id}", "/auth/enroll/{id}"],
		"device-secret",
		"Poll with {device_secret} and optional ?wait=0..60. Returns 202 pending or 200 with a one-time credential pair; 410 requires re-enrollment.",
	],
	[
		"get",
		["/_boot/approve/{id}", "/approve/{id}"],
		"public",
		"Immutable enrollment approval page displaying the user code and passkey controls.",
	],
	[
		"post",
		["/_boot/enroll/{id}/approve"],
		"proof",
		"Approve or deny with {decision,scopes,long_lived}, exact Origin and a fresh enrollment.decide X-Chirp-Assertion. No prior session required.",
	],
	[
		"post",
		["/_boot/refresh", "/auth/refresh"],
		"refresh-token",
		"Rotate {refresh}. Optional Idempotency-Key. Retry the same predecessor during the fixed 60-second replay window after a lost response.",
	],
	["get", ["/setup"], "public", "First-passkey setup page; available only before setup completes."],
	["get", ["/auth/login"], "public", "Human passkey sign-in page."],
	[
		"post",
		["/_boot/auth/setup/options"],
		"public",
		"Start first-passkey registration with {code} from boot stdout and exact Origin.",
	],
	[
		"post",
		["/_boot/auth/setup/verify"],
		"public",
		"Complete setup with {id,response} registration proof and exact Origin.",
	],
	["post", ["/_boot/auth/login/options"], "public", "Start passkey login with {} and exact Origin."],
	[
		"post",
		["/_boot/auth/login/verify"],
		"public",
		"Verify {id,response} passkey assertion with exact Origin; issues a secure human session cookie.",
	],
	["post", ["/_boot/auth/logout"], "human", "Revoke and clear the human session; exact Origin required."],
	[
		"post",
		["/_boot/auth/challenge"],
		"action-dependent",
		"Create {action,params} challenge for enrollment.decide, token.mint, token.revoke, lock.break, db.restore, generation.restore, boot.restart, app.reset, settings.change, passkey.add or passkey.delete. Exact Origin required; all except enrollment.decide require a human session. Complete using X-Chirp-Assertion: base64url JSON {id,response}.",
	],
	[
		"get",
		["/_boot/enrollments"],
		"human",
		"List complete persisted enrollment metadata as {items}; all query parameters are refused.",
	],
	[
		"get",
		["/_boot/tokens"],
		"human",
		"List complete token-family metadata as {items}; all query parameters are refused. Never returns token secrets.",
	],
	[
		"post",
		["/_boot/tokens", "/api/tokens"],
		"human",
		"Mint a token pair with exact Origin and a fresh token.mint X-Chirp-Assertion. Optional Idempotency-Key must be bound in the challenge.",
	],
	[
		"post",
		["/_boot/tokens/{family}/revoke", "/api/tokens/{family}/revoke"],
		"human",
		"Revoke a family with {}, exact Origin and a fresh token.revoke X-Chirp-Assertion.",
	],
	["get", ["/_boot/auth/passkeys"], "human", "List registered passkey metadata."],
	[
		"post",
		["/_boot/auth/passkeys/options"],
		"human",
		"Start additional-passkey registration with {label} and exact Origin.",
	],
	[
		"post",
		["/_boot/auth/passkeys/verify"],
		"human",
		"Finish registration with {id,label,response}, exact Origin and a fresh passkey.add X-Chirp-Assertion.",
	],
	[
		"delete",
		["/_boot/auth/passkeys/{id}"],
		"human",
		"Delete a passkey with {}, exact Origin and a fresh passkey.delete X-Chirp-Assertion. The last key cannot be deleted.",
	],
] as const satisfies ReadonlyArray<readonly [string, readonly string[], Access, string]>;

export const recoveryManifest = () => {
	const boot: Record<string, Schema.JsonObject> = {};
	for (const [method, aliases, access, description] of routes) {
		for (const path of aliases) {
			boot[path] = {
				...boot[path],
				[method]: {
					description,
					"x-chirp-auth": access,
					security:
						access === "human"
							? [{ commsBootSession: [] }]
							: access === "fs" || access === "read"
								? [{ commsBootSession: [] }, { commsBootAccess: [] }]
								: [],
					"x-chirp-scopes": access === "fs" || access === "read" ? [access] : [],
					parameters: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
						name: match[0].slice(1, -1),
						in: "path",
						required: true,
						schema: { type: "string" },
					})),
					responses: {
						default: { description: "See operation description; failures use {error:{code,message,hint,retriable}}." },
					},
				},
			};
		}
	}
	return {
		name: "chirp",
		endpoints: boot,
		components: {
			securitySchemes: {
				commsBootSession: { type: "apiKey", in: "cookie", name: "__Host-comms_session" },
				commsBootAccess: {
					type: "http",
					scheme: "bearer",
					description: "Enrolled access token; required scopes are given by x-chirp-scopes.",
				},
			},
		},
		init_url: "/init",
		api_url: "/api",
		recovery_url: "/_boot",
		auth: "passkey session or enrolled bearer access token",
		enrollment_url: "/auth/enroll",
		refresh_url: "/auth/refresh",
		capabilities: ["events", "source-edits", "reload", "enrollment", "refresh"],
	};
};
