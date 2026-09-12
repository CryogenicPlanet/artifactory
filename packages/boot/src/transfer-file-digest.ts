import { createHash } from "node:crypto";
import { Effect, FileSystem, Stream } from "effect";

/** Effect Crypto has no incremental digest API. Own the native hasher inside each file read;
 * Effect streams own filesystem I/O, so memory does not grow with the database artifact. */
export const transferFileDigest = (filename: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const digest = createHash("sha256");
		let bytes = 0;
		yield* fs.stream(filename).pipe(
			Stream.runForEach((chunk) =>
				Effect.gen(function* () {
					bytes += chunk.byteLength;
					if (!Number.isSafeInteger(bytes)) return yield* Effect.fail(new Error("Unsafe transfer artifact byte count"));
					digest.update(chunk);
				}),
			),
		);
		return { bytes, hash: digest.digest("hex") };
	});
