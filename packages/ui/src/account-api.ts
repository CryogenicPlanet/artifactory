import { assertionHeader } from "@comms/protocol/headers";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { BoardError } from "./board-api.ts";

const failure = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const explanation = (code: string) => {
	if (code === "last_passkey") return "Keep at least one passkey. Add another before removing this one.";
	if (code === "session_invalid") return "Your session expired. Sign in again, then reload this page.";
	if (code === "origin_has_passkeys") return "Remove the passkeys for this domain before removing the domain.";
	if (code === "origin_protected") return "Configured domains and the domain you are using cannot be removed here.";
	if (code === "origin_invalid") return "That domain is not valid. Use https://host with no path.";
	if (code === "passkey_exists") return "This passkey is already registered. Choose a different authenticator.";
	if (code === "challenge_invalid" || code === "assertion_invalid")
		return "The passkey confirmation expired or was used. Refresh the account list before trying again.";
	if (code === "idempotency_conflict")
		return "This token request conflicts with an earlier attempt. Check the token list before creating another.";
	return `Account request refused (${code}). Refresh the account list to check its current state.`;
};
export const accountRequest = (request: HttpClientRequest.HttpClientRequest, timeoutMs = 15000) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client.execute(request);
		if (response.status < 200 || response.status >= 300) {
			const message = yield* response.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(failure)),
				Effect.map((value) => explanation(value.error.code)),
				Effect.orElseSucceed(() => "The account request failed. Refresh to check its current state."),
			);
			return yield* new BoardError({ status: response.status, message });
		}
		return yield* response.json;
	}).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					new BoardError({
						status: 0,
						message:
							"The response was lost or delayed. The action may have completed; refresh the account list to check.",
					}),
				),
		}),
		Effect.catchTag("HttpClientError", () =>
			Effect.fail(
				new BoardError({
					status: 0,
					message: "Connection lost. The action may have completed; refresh the account list to check.",
				}),
			),
		),
	);
export const accountPost = (path: string, body: unknown, proof?: string, key?: string) =>
	accountRequest(
		HttpClientRequest.post(new URL(path, window.location.origin).href).pipe(
			HttpClientRequest.bodyJsonUnsafe(body),
			HttpClientRequest.setHeaders({
				...(proof ? { [assertionHeader]: proof } : {}),
				...(key ? { "Idempotency-Key": key } : {}),
			}),
		),
	);
const Passkeys = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			label: Schema.String,
			created_at: Schema.Int,
			rp_id: Schema.NullOr(Schema.String),
		}),
	),
	can_delete: Schema.Boolean,
});
const Families = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			family: Schema.String,
			agent: Schema.String,
			label: Schema.String,
			scopes: Schema.Array(Schema.String),
			created_at: Schema.Int,
			last_used_at: Schema.NullOr(Schema.Int),
			access_expires_at: Schema.NullOr(Schema.Int),
			refresh_expires_at: Schema.NullOr(Schema.Int),
			revoked: Schema.Boolean,
		}),
	),
});
export const TokenPair = Schema.Struct({
	access: Schema.String,
	refresh: Schema.String,
	expires_at: Schema.Int,
	scopes: Schema.Array(Schema.String),
	agent: Schema.String,
	label: Schema.String,
});
export type PasskeyList = typeof Passkeys.Type;
export type FamilyList = typeof Families.Type;
export type TokenPair = typeof TokenPair.Type;
export const unreadable = Effect.fail(
	new BoardError({
		status: 0,
		message: "The account returned an unreadable response. Refresh to check its current state.",
	}),
);
export const getPasskeys = Effect.suspend(() =>
	accountRequest(HttpClientRequest.get(new URL("/_boot/auth/passkeys", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Passkeys)),
		Effect.catchTag("SchemaError", () => unreadable),
	),
);
export const getFamilies = () =>
	accountRequest(HttpClientRequest.get(new URL("/_boot/tokens", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Families)),
		Effect.catchTag("SchemaError", () => unreadable),
	);
