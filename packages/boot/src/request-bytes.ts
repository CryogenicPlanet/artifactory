import { Effect, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";

/** Count streamed bytes before retaining a chunk; callers own deadlines and refusal policy. */
export const requestBytes = <E>(request: HttpServerRequest.HttpServerRequest, limit: number, tooLarge: E) =>
	Effect.gen(function* () {
		let bytes = 0;
		const chunks = yield* request.stream.pipe(
			Stream.tap((chunk) =>
				Effect.gen(function* () {
					bytes += chunk.byteLength;
					if (bytes > limit) return yield* Effect.fail(tooLarge);
				}),
			),
			Stream.runCollect,
		);
		return Buffer.concat(chunks);
	});
