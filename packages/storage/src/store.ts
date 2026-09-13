import { Effect, Redacted, Schema } from "effect";

/** A selected SQLite file, not a database identity or permission to create it. */
export interface FileStore {
	readonly _tag: "file";
	readonly filename: string;
}
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
	code: Schema.Literals(["store_descriptor_invalid", "store_engine_unsupported", "store_descriptor_mismatch"]),
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
export const render = (store: FileStore) =>
	Effect.try({
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
