import { applySecurity, type RouteScope } from "./api-security.ts";
import { liveDiscovery } from "./discovery.ts";
import { extGroup } from "@comms/protocol/extensions";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi";
import { sqlGroup, sqlHandlers } from "./sql-http.ts";
import type { Extensions } from "./kernel/ext.ts";
import { description as onboardingDescription, routes as onboardingRoutes } from "./onboarding.ts";
import { identity, failure, refusal } from "./conversation-request.ts";
export const SystemApi = HttpApi.make("chirp-system").add(sqlGroup).add(extGroup);
/** The manually mounted routes; every extension route carries its own scope through api.mount. */
const systemScopes: Readonly<Record<string, RouteScope | "public">> = {
	"/api": "read",
	"/api/ext": "read",
	// A SELECT needs read; a write needs fs, which the operation description states.
	"/api/sql": "read",
	"/init": "public",
	"/init.md": "public",
	"/quickstart": "read",
	"/quickstart.md": "read",
};

export const routes = (extensions: Extensions["Service"]) => {
	const system = OpenApi.fromApi(SystemApi.add(onboardingDescription));
	applySecurity(system.paths, (path) => systemScopes[path]);
	const specification = {
		...system,
		paths: Object.fromEntries(
			[...new Set([...Object.keys(system.paths), ...Object.keys(extensions.openapi.paths)])].map((path) => [
				path,
				{ ...system.paths[path], ...extensions.openapi.paths[path] },
			]),
		),
		components: {
			schemas: { ...extensions.openapi.components.schemas, ...system.components.schemas },
			securitySchemes: { ...extensions.openapi.components.securitySchemes, ...system.components.securitySchemes },
		},
	};
	return Layer.mergeAll(
		HttpApiBuilder.layer(SystemApi).pipe(
			Layer.provide(
				Layer.mergeAll(
					sqlHandlers(SystemApi),
					HttpApiBuilder.group(SystemApi, "ext", (handlers) =>
						handlers.handle("list", () =>
							refusal(
								Effect.gen(function* () {
									yield* identity("read");
									return yield* extensions.status;
								}),
							),
						),
					),
				),
			),
		),
		HttpRouter.add(
			"GET",
			"/api",
			Effect.gen(function* () {
				yield* identity("read");
				return HttpServerResponse.jsonUnsafe(yield* liveDiscovery(specification), {
					headers: { "cache-control": "no-store", vary: "Authorization, Cookie" },
				});
			}).pipe(failure),
		),
		onboardingRoutes(specification),
	);
};
