import { Atom } from "effect/unstable/reactivity";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError, json } from "./board-api.ts";

const Me = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	label: Schema.String,
	kind: Schema.Literals(["human", "agent"]),
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
});
export type CurrentAgent = typeof Me.Type;
const unreadable = () =>
	Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable identity. Try refreshing." }));
// This immutable atom description shares requests within the mounted RegistryProvider only.
export const getMe = Atom.make(
	Effect.suspend(() =>
		json(HttpClientRequest.get(new URL("/api/me", window.location.origin).href)).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Me)),
			Effect.catchTag("SchemaError", unreadable),
		),
	),
);
export const profileHref = (agent: string) => `/@${encodeURIComponent(agent)}`;
export const profilePath = () => {
	try {
		const path = decodeURIComponent(window.location.pathname);
		return /^\/@[a-z0-9][a-z0-9._-]{0,63}$/.test(path) ? path.slice(2) : null;
	} catch {
		return null;
	}
};
