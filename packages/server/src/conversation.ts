import { liveDiscovery } from "./discovery.ts";
import { extGroup } from "@comms/protocol/extensions";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi";
import { sqlGroup, sqlHandlers } from "./sql-http.ts";
import type { Extensions } from "./kernel/ext.ts";
import { description as onboardingDescription, routes as onboardingRoutes } from "./onboarding.ts";
import { identity, failure, refusal } from "./conversation-request.ts";
export const SystemApi = HttpApi.make("comms-system").add(sqlGroup).add(extGroup);
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
