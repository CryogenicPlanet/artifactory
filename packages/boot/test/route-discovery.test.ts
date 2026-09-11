import { Effect, Schema } from "effect";
import { HttpClientRequest, HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { discoveryResponse, mergeDiscovery } from "../src/route-discovery.ts";

it("preserves extension schemas and operations while replacing boot-owned paths", () => {
	const document = {
		paths: {
			"/api/reload": { get: { description: "forged" } },
			"/api/example": { get: { responses: { "200": { $ref: "#/components/schemas/Example" } } } },
		},
		components: {
			schemas: { Example: { type: "object" } },
			securitySchemes: { extension: { type: "http", scheme: "bearer" } },
		},
	};
	const merged = mergeDiscovery(document, "paths");
	const paths = Schema.decodeUnknownSync(Schema.JsonObject)(merged.paths);
	expect(paths["/api/reload"]).not.toHaveProperty("get");
	expect(paths["/api/reload"]).toHaveProperty("post.security", [{ commsBootSession: [] }, { commsBootAccess: [] }]);
	expect(paths["/api/example"]).toEqual(document.paths["/api/example"]);
	expect(merged.components).toHaveProperty("schemas", document.components.schemas);
	expect(merged.components.securitySchemes).toHaveProperty("extension", document.components.securitySchemes.extension);
	expect(paths["/auth/enroll"]).toHaveProperty("post.security", []);
	expect(paths["/_boot/db/restore"]).toHaveProperty("post.security", [{ commsBootSession: [] }]);
	expect(document.paths["/api/reload"]).toHaveProperty("get");
});

const respond = (body: BodyInit, status = 200) =>
	HttpClientResponse.fromWeb(HttpClientRequest.get("http://localhost/api"), new Response(body, { status }));
it("re-encodes discovery as JSON without child length, encoding, cache or credential headers", async () => {
	const response = HttpClientResponse.fromWeb(
		HttpClientRequest.get("http://localhost/api"),
		new Response('{"paths":{}}', { headers: { "content-length": "12", etag: "old", "x-boot-secret": "private" } }),
	);
	const merged = await Effect.runPromise(discoveryResponse("/api", "GET", response));
	if (!merged) throw new Error("Expected discovery response");
	const web = HttpServerResponse.toWeb(merged);
	expect(web.headers.get("cache-control")).toBe("no-store");
	expect(web.headers.get("etag")).toBeNull();
	expect(web.headers.get("x-boot-secret")).toBeNull();
	expect(await web.json()).toHaveProperty("paths./api/reload.post.description");
});

it.for(["[]", '{"paths":[]}', "bad json", " ".repeat(2 * 1024 * 1024 + 1)])(
	"refuses malformed or oversized discovery %#",
	async (body) => {
		const result = await Effect.runPromise(discoveryResponse("/api", "GET", respond(body)).pipe(Effect.result));
		expect(result._tag).toBe("Failure");
	},
);

it("leaves ordinary streams, HEAD and failure responses unconsumed", async () => {
	for (const [path, method, status] of [
		["/stream", "GET", 200],
		["/api", "HEAD", 200],
		["/api", "GET", 503],
	] as const) {
		const response = respond("unchanged", status);
		expect(await Effect.runPromise(discoveryResponse(path, method, response))).toBeNull();
		expect(await Effect.runPromise(response.text)).toBe("unchanged");
	}
});
