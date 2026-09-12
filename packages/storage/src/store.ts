import type { RemoteConnection } from "./remote-session.ts";
import { Effect, Redacted, Schema } from "effect";

/** A selected SQLite file, not a database identity or permission to create it. */
export interface FileStore {
	readonly _tag: "file";
	readonly filename: string;
}
/** Credentials are retained only inside the redacted URL. */
export interface RemoteStore {
	readonly _tag: "postgres" | "mysql";
	readonly url: Redacted.Redacted<string>;
	readonly database: string;
}
export type Store = FileStore | RemoteStore;

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
	code: Schema.Literals([
		"store_descriptor_invalid",
		"store_engine_unsupported",
		"store_descriptor_mismatch",
		"store_engine_mismatch",
	]),
	variable: Schema.optionalKey(Schema.Literals(["APP_STORE", "APP_DATABASE"])),
}) {
	override get message() {
		return this.variable ? `${this.variable}: ${this.code}` : this.code;
	}
}

/** POSIX absolute paths only. Never opens a store or includes the supplied value in an error. */
export const parse = (raw: string) =>
	Effect.gen(function* () {
		if (/^(postgres|postgresql|mysql):/i.test(raw)) return yield* new StoreError({ code: "store_engine_unsupported" });
		if (!raw.startsWith("file:/") || raw.startsWith("file://") || /[?#\\\x00-\x20\x7f]/.test(raw))
			return yield* new StoreError({ code: "store_descriptor_invalid" });
		const filename = yield* Effect.try({
			try: () => decodeURIComponent(raw.slice(5)),
			catch: () => new StoreError({ code: "store_descriptor_invalid" }),
		});
		if (
			!filename.startsWith("/") ||
			filename === "/" ||
			/[\\\x00-\x1f\x7f]/.test(filename) ||
			filename
				.slice(1)
				.split("/")
				.some((part) => part === "" || part === "." || part === "..")
		)
			return yield* new StoreError({ code: "store_descriptor_invalid" });
		return { _tag: "file", filename } satisfies FileStore;
	});

/** Rendering cannot produce a descriptor the parser rejects, including malformed Unicode. */
export const render = (store: Store) =>
	store._tag !== "file"
		? Effect.succeed(store.url)
		: Effect.try({
				try: () => `file:${store.filename.split("/").map(encodeURIComponent).join("/")}`,
				catch: () => new StoreError({ code: "store_descriptor_invalid" }),
			}).pipe(Effect.flatMap((raw) => parse(raw).pipe(Effect.as(Redacted.make(raw)))));

/** Old images provide only APP_DATABASE; current images provide both. Validate either selection. */
export const childStore = (raw: string | undefined, legacy?: string) =>
	Effect.gen(function* () {
		const variable = raw === undefined && legacy !== undefined ? "APP_DATABASE" : "APP_STORE";
		const selected =
			raw === undefined
				? legacy === undefined
					? Effect.fail(new StoreError({ code: "store_descriptor_invalid" }))
					: render({ _tag: "file", filename: legacy }).pipe(Effect.map(Redacted.value))
				: Effect.succeed(raw);
		return yield* selected.pipe(
			Effect.flatMap(parse),
			Effect.filterOrFail(
				(store) => legacy === undefined || legacy === store.filename,
				() => new StoreError({ code: "store_descriptor_mismatch" }),
			),
			Effect.mapError((error) => new StoreError({ code: error.code, variable })),
		);
	});

const validDatabase = (database: string) =>
	database.length > 0 && database !== "." && database !== ".." && !/[\\/\x00-\x1f\x7f]/.test(database);

/** Parse the future remote configuration without enabling it in SQLite-only callers. */
export const parseDescriptor = (raw: string): Effect.Effect<Store, StoreError> => {
	if (raw.startsWith("file:")) return parse(raw);
	return Effect.try({
		try: () => {
			const match = /^(postgres|postgresql|mysql):\/\/([^/]+)\/([^/?#]+)$/.exec(raw);
			if (!match || /[?#\\\x00-\x20\x7f]/.test(raw)) throw new Error();
			const url = new URL(raw);
			const database = decodeURIComponent(match[3] ?? "");
			// Decode credentials here only to reject malformed escapes; never retain or report them.
			decodeURIComponent(url.username);
			decodeURIComponent(url.password);
			if (!url.hostname || !validDatabase(database)) throw new Error();
			const tag = url.protocol === "mysql:" ? "mysql" : "postgres";
			url.protocol = `${tag}:`;
			url.pathname = `/${encodeURIComponent(database)}`;
			return { _tag: tag, url: Redacted.make(url.href), database } satisfies RemoteStore;
		},
		catch: () => new StoreError({ code: "store_descriptor_invalid" }),
	});
};

/** Select a clone/restore database without changing the remote endpoint or credentials. */
export const withDatabase = (store: RemoteStore, database: string): Effect.Effect<RemoteStore, StoreError> =>
	Effect.try({
		try: () => {
			if (!validDatabase(database)) throw new Error();
			const url = new URL(Redacted.value(store.url));
			url.pathname = `/${encodeURIComponent(database)}`;
			return { ...store, url: Redacted.make(url.href), database };
		},
		catch: () => new StoreError({ code: "store_descriptor_invalid" }),
	});

/** Boot credential on the app database, only on the same engine and endpoint. */
export const asBoot = (app: RemoteStore, boot: RemoteStore): Effect.Effect<RemoteStore, StoreError> =>
	Effect.gen(function* () {
		const matches = yield* Effect.try({
			try: () => {
				const appUrl = new URL(Redacted.value(app.url));
				const bootUrl = new URL(Redacted.value(boot.url));
				const defaultPort = app._tag === "postgres" ? "5432" : "3306";
				return (
					app._tag === boot._tag &&
					app.database !== boot.database &&
					appUrl.hostname.toLowerCase() === bootUrl.hostname.toLowerCase() &&
					(appUrl.port || defaultPort) === (bootUrl.port || defaultPort)
				);
			},
			catch: () => new StoreError({ code: "store_descriptor_invalid" }),
		});
		if (!matches) return yield* new StoreError({ code: "store_engine_mismatch" });
		return yield* withDatabase(boot, app.database);
	});

/** Explicit driver fields; URL query options cannot override credentials, database or TLS. */
export const connectionOf = (store: RemoteStore, tls: boolean) =>
	Effect.try({
		try: (): RemoteConnection => {
			const url = new URL(Redacted.value(store.url));
			const username = decodeURIComponent(url.username);
			const password = decodeURIComponent(url.password);
			if (!username || !password) throw new Error();
			return {
				engine: store._tag === "postgres" ? "pg" : "mysql",
				host: url.hostname.replace(/^\[|\]$/g, ""),
				port: Number(url.port || (store._tag === "postgres" ? 5432 : 3306)),
				database: store.database,
				username,
				password: Redacted.make(password),
				tls,
			};
		},
		catch: () => new StoreError({ code: "store_descriptor_invalid" }),
	});
