import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpServerResponse } from "effect/unstable/http";
import { expect, test } from "vitest";
import { AuthError } from "../src/auth.ts";
import { databaseRestoreResponse } from "../src/database-restore-http.ts";
import type { DatabaseRestore } from "../src/database-restore.ts";
import { SourceRejected } from "../src/source-schema.ts";

const responseFor = (cause: Cause.Cause<SourceRejected | AuthError>) =>
	Effect.gen(function* () {
		const restore: DatabaseRestore = { recover: Effect.void, restore: () => Effect.failCause(cause) };
		const response = yield* databaseRestoreResponse(
			restore,
			{ generation: 1, withDb: true },
			{
				id: "proof",
				response: {
					id: "key",
					rawId: "key",
					type: "public-key",
					clientExtensionResults: {},
					response: { clientDataJSON: "", authenticatorData: "", signature: "" },
				},
			},
			"session",
		);
		const body = yield* HttpServerResponse.toClientResponse(response).json.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Struct({
						error: Schema.Struct({
							code: Schema.String,
							message: Schema.String,
							hint: Schema.String,
							retriable: Schema.Boolean,
						}),
					}),
				),
			),
		);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(body.error.retriable).toBe(false);
		return { status: response.status, error: body.error };
	}).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)));

test("returns an actionable conflict for a lone external source conflict", async () => {
	const result = await Effect.runPromise(
		responseFor(Cause.fail(new SourceRejected({ code: "external_conflict", path: "app/main.ts" }))),
	);
	expect(result.status).toBe(409);
	expect(result.error.code).toBe("external_conflict");
	expect(result.error.hint).toMatch(/repair/i);
});

for (const scenario of ["conflict with defect", "defect", "missing backup with defect"] as const) {
	test(`keeps ${scenario} as a non-retryable handler failure`, async () => {
		const defect = Cause.die("private verifier diagnostic");
		const cause =
			scenario === "conflict with defect"
				? Cause.combine(Cause.fail(new SourceRejected({ code: "external_conflict", path: "app/main.ts" })), defect)
				: scenario === "missing backup with defect"
					? Cause.combine(Cause.fail(new AuthError({ code: "backup_not_found" })), defect)
					: defect;
		const result = await Effect.runPromise(responseFor(cause));
		expect(result.status).toBe(500);
		expect(result.error.code).toBe("handler_failed");
		expect(result.error.message).not.toContain("private verifier diagnostic");
		expect(result.error.hint).not.toContain("private verifier diagnostic");
	});
}
