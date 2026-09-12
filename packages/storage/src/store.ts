import { Effect, Redacted, Schema } from "effect";

/** A selected SQLite file, not a database identity or permission to create it. */
export interface FileStore {
	readonly _tag: "file";
	readonly filename: string;
}
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
	code: Schema.Literals(["store_descriptor_invalid", "store_engine_unsupported", "store_descriptor_mismatch"]),
}) {
	override get message() {
		return this.code;
	}
}

/** Encode each path segment: ?, # and % are filenames, never connection options. */
export const render = (store: FileStore): Redacted.Redacted<string> =>
	Redacted.make(`file:${store.filename.split("/").map(encodeURIComponent).join("/")}`);

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

/** Retained generations still read APP_DATABASE. Never accept conflicting selections. */
export const childStore = (raw: string, legacy?: string) =>
	parse(raw).pipe(
		Effect.flatMap((store) =>
			legacy !== undefined && legacy !== store.filename
				? Effect.fail(new StoreError({ code: "store_descriptor_mismatch" }))
				: Effect.succeed(store),
		),
	);
