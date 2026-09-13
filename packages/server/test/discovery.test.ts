import { agentHeader } from "@comms/protocol/headers";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { expect, it } from "vitest";
import { liveDiscovery } from "../src/discovery.ts";

it("composes immutable metadata without forwarding credentials or replacing extension schemas", async () => {
	const base = OpenApi.fromApi(
		HttpApi.make("example").add(
			HttpApiGroup.make("example").add(HttpApiEndpoint.get("example", "/api/example", { success: Schema.String })),
		),
	);
	const manifest = {
		endpoints: { "/api/reload": { post: { description: "Immutable reload", security: [{ commsBootAccess: [] }] } } },
		components: { securitySchemes: { commsBootAccess: { type: "http", scheme: "bearer" } } },
	};
	const client = HttpClient.make((request) => {
		expect(request.method).toBe("GET");
		expect(request.url).toBe("http://localhost/.well-known/agent.json");
		for (const name of ["authorization", "cookie", "x-boot-secret", agentHeader])
			expect(request.headers[name]).toBeUndefined();
		return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(manifest)));
	});
	const merged = await Effect.runPromise(
		liveDiscovery({
			...base,
			paths: {
				...base.paths,
				"/api/reload": {
					get: {
						operationId: "forged",
						parameters: [],
						tags: ["example"],
						security: [],
						responses: { "200": { description: "forged" } },
					},
				},
			},
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(HttpClient.HttpClient, client),
					ConfigProvider.layer(ConfigProvider.fromUnknown({ BOOT_URL: "http://localhost", BOOT_SECRET: "private" })),
				),
			),
		),
	);
	expect(merged.paths["/api/reload"]).toEqual(manifest.endpoints["/api/reload"]);
	expect(merged.paths["/api/example"]).toEqual(base.paths["/api/example"]);
	expect(merged.components.schemas).toEqual(base.components.schemas);
	expect(merged.components.securitySchemes.commsBootAccess).toEqual(
		manifest.components.securitySchemes.commsBootAccess,
	);
});

it.for([503, 200])("refuses unavailable or malformed immutable metadata (%s)", async (status) => {
	const client = HttpClient.make((request) =>
		Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status }))),
	);
	const result = await Effect.runPromise(
		liveDiscovery(OpenApi.fromApi(HttpApi.make("example"))).pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(HttpClient.HttpClient, client),
					ConfigProvider.layer(ConfigProvider.fromUnknown({ BOOT_URL: "http://localhost" })),
				),
			),
			Effect.result,
		),
	);
	expect(result).toMatchObject({ _tag: "Failure", failure: { code: "boot_unavailable" } });
});
