import { expect, it } from "vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { pageFailure } from "../src/page-failure.ts";
import { PageRejected } from "../src/ext/core/pages.ts";
import { KernelError } from "../src/kernel/boot-channel.ts";
import { routes as assetRoutes } from "../src/page-assets.ts";

it("preserves page and kernel refusals but names unknown and mixed defects without exposing details", async () => {
	for (const [effect, status, code] of [
		[Effect.fail(new PageRejected({ code: "page_not_found" })), 404, "page_not_found"],
		[Effect.fail(new PageRejected({ code: "page_path_invalid" })), 400, "page_path_invalid"],
		[Effect.fail(new PageRejected({ code: "pages_unavailable" })), 503, "pages_unavailable"],
		[Effect.fail(new PageRejected({ code: "pages_move_pending" })), 503, "pages_move_pending"],
		[Effect.fail(new KernelError({ code: "scope_required" })), 403, "scope_required"],
		[Effect.fail(new KernelError({ code: "boot_unavailable" })), 503, "boot_unavailable"],
		[Effect.fail("private unknown"), 500, "handler_failed"],
		[Effect.die("private renderer defect"), 500, "handler_failed"],
		[
			Effect.failCause(
				Cause.combine(
					Cause.fail(new PageRejected({ code: "pages_unavailable" })),
					Cause.die("private finalizer defect"),
				),
			),
			500,
			"handler_failed",
		],
	] satisfies ReadonlyArray<readonly [Effect.Effect<never, PageRejected | KernelError | string>, number, string]>) {
		const response = HttpServerResponse.toWeb(
			await Effect.runPromise(
				pageFailure<never, PageRejected | KernelError | string, never>(effect).pipe(
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(new Request("http://localhost/p/notes.md?secret=private")),
					),
				),
			),
		);
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json();
		expect(body).toMatchObject({ error: { code, retriable: status === 503 } });
		expect(JSON.stringify(body)).not.toContain("private");
		if (code === "handler_failed") expect(body.error.message).toBe("Handler failed for GET /p/notes.md.");
		if (code === "pages_unavailable") expect(body.error.hint).toContain("/_boot/status");
	}
	const interrupted = await Effect.runPromise(Effect.exit(pageFailure(Effect.interrupt)));
	expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
});

it("the actual asset route returns a named 500 for file defects and preserves cancellation", async () => {
	for (const interrupted of [false, true]) {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const handler = yield* HttpRouter.toHttpEffect(assetRoutes);
				return yield* handler.pipe(
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(new Request("http://localhost/page-assets/markdown.css?secret=private")),
					),
					Effect.exit,
				);
			}).pipe(
				Effect.scoped,
				Effect.provide(HttpPlatform.layer),
				Effect.provide(
					Layer.mergeAll(
						Path.layer,
						Etag.layerWeak,
						FileSystem.layerNoop({
							stat: () => (interrupted ? Effect.interrupt : Effect.die("private asset defect")),
						}),
					),
				),
			),
		);
		if (interrupted) {
			expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
		} else {
			if (Exit.isFailure(result)) throw new Error(Cause.pretty(result.cause));
			const response = HttpServerResponse.toWeb(result.value);
			expect(response.status).toBe(500);
			const body = await response.json();
			expect(body).toMatchObject({
				error: {
					code: "handler_failed",
					retriable: false,
					message: "Handler failed for GET /page-assets/markdown.css.",
				},
			});
			expect(JSON.stringify(body)).not.toContain("private");
		}
	}
});
