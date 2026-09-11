import { Effect, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import type { Api } from "./conversation.ts";
import { failure, identity } from "./conversation-request.ts";
import { KernelError } from "./kernel/boot-channel.ts";
import { AgentList, Profile, ProfilePatch, Profiles } from "./kernel/profiles.ts";

const Me = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["agent", "human"]),
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
	profile: Profile,
});
export const profilesGroup = HttpApiGroup.make("profiles").add(
	HttpApiEndpoint.get("me", "/api/me", { success: Me }).annotate(
		OpenApi.Description,
		"Read verified caller identity, granted scopes, credential expiry and shared agent profile. Requires read; expiry is epoch milliseconds, and no credential is returned.",
	),
	HttpApiEndpoint.patch("updateMe", "/api/me", { payload: ProfilePatch, success: Me }).annotate(
		OpenApi.Description,
		"Update only this agent's shared status, emoji or color. Requires write. Status is at most1024 characters; emoji is null or at most64 non-whitespace characters; color is null or #RRGGBB. Omitted fields remain unchanged.",
	),
	HttpApiEndpoint.get("agents", "/api/agents", { success: AgentList }).annotate(
		OpenApi.Description,
		"List agent profiles and boot-verified instances. Requires read. Last seen is authentication time, not an online guarantee. Historical enrolled families remain visible; logged-out human sessions do not.",
	),
);
const me = (write: boolean) =>
	Effect.gen(function* () {
		const who = yield* identity(write ? "write" : "read");
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (new URL(request.url, "http://localhost").search.length > 0)
			return yield* new KernelError({ code: "query_invalid" });
		const expires = Number(request.headers["x-comms-token-expires"]);
		if (!Number.isSafeInteger(expires) || expires <= 0) return yield* new KernelError({ code: "scope_required" });
		const profiles = yield* Profiles;
		let profile;
		if (write) {
			let bytes = 0;
			const chunks = yield* request.stream.pipe(
				Stream.tap((chunk) =>
					Effect.gen(function* () {
						bytes += chunk.byteLength;
						if (bytes > 8192) return yield* new KernelError({ code: "input_invalid" });
					}),
				),
				Stream.runCollect,
				Effect.timeout("5 seconds"),
			);
			const patch = yield* Schema.decodeEffect(Schema.fromJsonString(ProfilePatch))(
				Buffer.concat(chunks).toString("utf8"),
				{ onExcessProperty: "error" },
			).pipe(Effect.mapError(() => new KernelError({ code: "input_invalid" })));
			profile = yield* profiles.update(who.agent, patch);
		} else profile = yield* profiles.get(who.agent);
		return HttpServerResponse.jsonUnsafe(
			{
				agent: who.agent,
				instance: who.instance,
				label: who.label,
				kind: who.kind,
				scopes: request.headers["x-comms-scopes"]?.split(",") ?? [],
				expires_at: expires,
				profile,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	});
export const profilesHandlers = (api: typeof Api) =>
	HttpApiBuilder.group(api, "profiles", (handlers) =>
		handlers
			.handleRaw("me", () => failure(me(false)))
			.handleRaw("updateMe", () => failure(me(true)))
			.handleRaw("agents", () =>
				failure(
					Effect.gen(function* () {
						yield* identity("read");
						const request = yield* HttpServerRequest.HttpServerRequest;
						if (new URL(request.url, "http://localhost").search.length > 0)
							return yield* new KernelError({ code: "query_invalid" });
						return HttpServerResponse.jsonUnsafe(yield* (yield* Profiles).list, {
							headers: { "cache-control": "no-store" },
						});
					}),
				),
			),
	);
