import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi";
import { sqlGroup, sqlHandlers } from "./sql-http.ts";
import type { Extensions } from "./kernel/ext.ts";
import { description as onboardingDescription, routes as onboardingRoutes } from "./onboarding.ts";
import { identity, failure } from "./conversation-request.ts";
export const SystemApi = HttpApi.make("comms-system").add(sqlGroup);
export const routes = (extensions: Extensions["Service"]) => {
	const system = OpenApi.fromApi(SystemApi.add(onboardingDescription));
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
		HttpRouter.add(
			"GET",
			"/api/ext",
			failure(
				Effect.gen(function* () {
					yield* identity("read");
					return HttpServerResponse.jsonUnsafe(yield* extensions.status);
				}),
			),
		),
		HttpApiBuilder.layer(SystemApi).pipe(Layer.provide(sqlHandlers(SystemApi))),
		HttpRouter.add(
			"GET",
			"/api",
			Effect.gen(function* () {
				yield* identity("read");
				return HttpServerResponse.jsonUnsafe(specification);
			}).pipe(failure),
		),
		onboardingRoutes(specification),
	);
};
