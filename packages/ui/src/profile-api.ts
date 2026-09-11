import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError, json } from "./board-api.ts";

const Profile = Schema.Struct({
	emoji: Schema.NullOr(Schema.String),
	color: Schema.NullOr(Schema.String),
	status: Schema.String,
});
const Me = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["human", "agent"]),
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
	profile: Profile,
});
const Agents = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			agent: Schema.String,
			kind: Schema.String,
			profile: Profile,
			created_at: Schema.Int,
			last_seen_at: Schema.NullOr(Schema.Int),
			instances: Schema.Array(
				Schema.Struct({
					instance: Schema.String,
					label: Schema.String,
					kind: Schema.String,
					created_at: Schema.Int,
					last_seen_at: Schema.NullOr(Schema.Int),
				}),
			),
		}),
	),
});
export type AgentProfile = typeof Profile.Type;
export type CurrentAgent = typeof Me.Type;
export type BoardAgent = (typeof Agents.Type.items)[number];
const unreadable = () =>
	Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable profile. Try refreshing." }));
export const getMe = Effect.suspend(() =>
	json(HttpClientRequest.get(new URL("/api/me", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Me)),
		Effect.catchTag("SchemaError", unreadable),
	),
);
export const getAgents = Effect.suspend(() =>
	json(HttpClientRequest.get(new URL("/api/agents", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Agents)),
		Effect.catchTag("SchemaError", unreadable),
	),
);
export const saveProfile = (profile: AgentProfile) =>
	json(
		HttpClientRequest.patch(new URL("/api/me", window.location.origin).href).pipe(
			HttpClientRequest.bodyJsonUnsafe(profile),
		),
	).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Me)), Effect.catchTag("SchemaError", unreadable));
export const profileHref = (agent: string) => `/@${encodeURIComponent(agent)}`;
export const profilePath = () => {
	try {
		const path = decodeURIComponent(window.location.pathname);
		return /^\/@[a-z0-9][a-z0-9._-]{0,63}$/.test(path) ? path.slice(2) : null;
	} catch {
		return null;
	}
};
