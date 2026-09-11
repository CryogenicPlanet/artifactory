import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError, json } from "./board-api.ts";

const Extension = Schema.Struct({
	name: Schema.String,
	status: Schema.Literals(["loaded", "disabled"]),
	load_ms: Schema.Finite,
	error: Schema.NullOr(Schema.String),
	registrations: Schema.Array(
		Schema.Struct({
			method: Schema.String,
			path: Schema.String,
			description: Schema.String,
			scope: Schema.String,
		}),
	),
});
const Lock = Schema.Struct({
	agent: Schema.String,
	holder_family: Schema.String,
	expires: Schema.Int,
	note: Schema.String,
	cutover_in_flight: Schema.Literals([0, 1]),
	pending_release: Schema.NullOr(Schema.String),
});
export type ExtensionStatus = typeof Extension.Type;
export type EditLock = typeof Lock.Type;
const get = (path: string) =>
	Effect.suspend(() => json(HttpClientRequest.get(new URL(path, window.location.origin).href))).pipe(
		Effect.catchTag("BoardError", (error) =>
			Effect.fail(
				new BoardError({
					status: error.status,
					message:
						error.status === 401
							? "Sign in with your passkey to continue."
							: error.status === 403
								? "This view requires source access."
								: error.message,
				}),
			),
		),
	);
const unreadable = () =>
	Effect.fail(new BoardError({ status: 0, message: "The board returned an unreadable status. Try refreshing." }));
export const getExtensions = get("/api/ext").pipe(
	Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Extension))),
	Effect.catchTag("SchemaError", unreadable),
);
export const getEditLock = get("/_boot/lock").pipe(
	Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ lock: Schema.NullOr(Lock) }))),
	Effect.map((response) => response.lock),
	Effect.catchTag("SchemaError", unreadable),
);
