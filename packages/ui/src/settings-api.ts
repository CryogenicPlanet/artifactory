import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { accountPost, accountRequest } from "./account-api.ts";
import { BoardError } from "./board-api.ts";

const Storage = Schema.Struct({
	backup_percent: Schema.Finite,
	event_percent: Schema.Finite,
	headroom_percent: Schema.Finite,
});
const Settings = Schema.Struct({
	revision: Schema.Int,
	storage: Storage,
	public_paths: Schema.Array(Schema.String),
});
export type Settings = typeof Settings.Type;
export type SettingsChange = { readonly revision: number; readonly patch: Omit<Settings, "revision"> };
const decode = Schema.decodeUnknownEffect(Settings);
const unreadable = () =>
	Effect.fail(
		new BoardError({
			status: 0,
			message: "Settings returned an unreadable response. Refresh current settings before deciding whether to retry.",
		}),
	);
export const getSettings = Effect.suspend(() =>
	accountRequest(HttpClientRequest.get(new URL("/_boot/settings", window.location.origin).href)).pipe(
		Effect.flatMap(decode),
		Effect.catchTag("SchemaError", unreadable),
	),
);
export const settingsError = (error: BoardError) => {
	const messages: Readonly<Partial<Record<number, string>>> = {
		0: "The settings response was lost or unreadable. Read current settings before starting a new confirmation; an exact signed retry will not apply the change twice.",
		400: "Settings were refused. Check the storage percentages and exact public paths before confirming again.",
		401: "Your session or passkey confirmation expired. Sign in again if needed, then read current settings before a new confirmation.",
		403: "Settings require a human session and a fresh passkey confirmation from this board.",
		409: "Settings changed since this draft began. Refresh and compare current values before confirming a new revision.",
	};
	return new BoardError({ status: error.status, message: messages[error.status] ?? error.message });
};
export const changeSettings = (body: SettingsChange, proof: string) =>
	accountPost("/_boot/settings", body, proof).pipe(
		Effect.flatMap(decode),
		Effect.catchTag("SchemaError", unreadable),
		Effect.catchTag("BoardError", (error) => Effect.fail(settingsError(error))),
	);
