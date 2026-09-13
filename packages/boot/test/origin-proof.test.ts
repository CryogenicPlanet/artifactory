import { type Duration, Effect, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { fetchOriginProof } from "../src/origin-proof.ts";

const run = (url: string, respond: () => Response | null, timeout: Duration.Input = "1 second") => {
	const calls: string[] = [];
	const client = HttpClient.make((request) =>
		Effect.suspend(() => {
			calls.push(request.url);
			const response = respond();
			return response === null ? Effect.never : Effect.succeed(HttpClientResponse.fromWeb(request, response));
		}),
	);
	return Effect.runPromise(
		fetchOriginProof(url, timeout).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result),
	).then((result) => ({ result, calls }));
};
const reason = (result: Result.Result<string, { readonly reason: string }>) =>
	Result.isFailure(result) ? result.failure.reason : null;

it("returns the proof body from the named domain's exact proof URL", async () => {
	const { result, calls } = await run("https://new.test/_boot/auth/origin-proof/abc", () => new Response("nonce"));
	expect(Result.isSuccess(result) && result.success).toBe("nonce");
	expect(calls).toEqual(["https://new.test/_boot/auth/origin-proof/abc"]);
});

it("refuses redirects, other statuses, oversized bodies and timeouts", async () => {
	const target = "https://new.test/_boot/auth/origin-proof/abc";
	expect(
		reason(
			(await run(target, () => new Response(null, { status: 302, headers: { location: "https://x.test" } }))).result,
		),
	).toBe("redirect");
	expect(reason((await run(target, () => new Response("nonce", { status: 404 }))).result)).toBe("status");
	expect(reason((await run(target, () => new Response("x".repeat(2048)))).result)).toBe("too_large");
	expect(reason((await run(target, () => null, "50 millis")).result)).toBe("timeout");
});

it("only fetches https, or http on localhost", async () => {
	for (const url of ["http://new.test/_boot/auth/origin-proof/abc", "ftp://new.test/x", "not a url"]) {
		const { result, calls } = await run(url, () => new Response("nonce"));
		expect(reason(result)).toBe("scheme");
		expect(calls).toEqual([]);
	}
	const local = await run("http://localhost:8080/_boot/auth/origin-proof/abc", () => new Response("nonce"));
	expect(Result.isSuccess(local.result) && local.result.success).toBe("nonce");
});
