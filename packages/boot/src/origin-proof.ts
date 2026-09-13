import { Cause, type Duration, Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export class OriginProofError extends Schema.TaggedError<OriginProofError>()("OriginProofError", {
	reason: Schema.Literals(["scheme", "redirect", "status", "too_large", "timeout", "network"]),
}) {}

/** The exact public path a newly named domain must route to this board for its proof to be fetched. */
export const originProofPath = (id: string) => `/_boot/auth/origin-proof/${id}`;
const maxProofBytes = 1024;

/** GET a proof from a named domain: https only (http for localhost), no redirects, bounded time and size. */
export const fetchOriginProof = (url: string, timeout: Duration.Input = "5 seconds") =>
	Effect.gen(function* () {
		const target = URL.canParse(url) ? new URL(url) : null;
		if (!target || !(target.protocol === "https:" || (target.protocol === "http:" && target.hostname === "localhost")))
			return yield* new OriginProofError({ reason: "scheme" });
		const client = yield* HttpClient.HttpClient;
		// Redirects are never followed: the proof must come from the named domain itself.
		const response = yield* client
			.execute(HttpClientRequest.get(target.href))
			.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
		if (response.status >= 300 && response.status < 400) return yield* new OriginProofError({ reason: "redirect" });
		if (response.status !== 200) return yield* new OriginProofError({ reason: "status" });
		const chunks = yield* Stream.runFoldEffect(
			response.stream,
			(): ReadonlyArray<Uint8Array> => [],
			(received, chunk) =>
				received.reduce((total, part) => total + part.length, chunk.length) > maxProofBytes
					? Effect.fail(new OriginProofError({ reason: "too_large" }))
					: Effect.succeed([...received, chunk]),
		);
		return new TextDecoder().decode(Buffer.concat(chunks));
	}).pipe(
		Effect.timeout(timeout),
		Effect.mapError((error) =>
			Schema.is(OriginProofError)(error)
				? error
				: new OriginProofError({ reason: Cause.isTimeoutError(error) ? "timeout" : "network" }),
		),
	);
