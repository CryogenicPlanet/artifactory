import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, type HttpServerError } from "effect/unstable/http";
import { HttpApiBuilder, OpenApi, type HttpApi, type HttpApiGroup } from "effect/unstable/httpapi";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { KernelError } from "./boot-channel.ts";
import { boundedRequest } from "../request-schema.ts";
import { requestErrorCode } from "../conversation-request.ts";
import type { ExtensionServices } from "./extension-api.ts";

const methods: ReadonlyArray<HttpMethod> = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const operation = (path: OpenApi.OpenAPISpecPathItem, method: HttpMethod) => {
	switch (method) {
		case "GET":
			return path.get;
		case "POST":
			return path.post;
		case "PUT":
			return path.put;
		case "PATCH":
			return path.patch;
		case "DELETE":
			return path.delete;
		case "HEAD":
			return path.head;
		case "OPTIONS":
			return path.options;
		default:
			return undefined;
	}
};

/** A mounted API owns both its real typed dispatcher and the schemas used to describe it. */
export const mountApi = <Id extends string, Groups extends HttpApiGroup.Constraint, E>(
	definition: HttpApi.HttpApi<Id, Groups>,
	handlers: Layer.Layer<
		HttpApiGroup.ToService<Id, Groups>,
		E,
		ExtensionServices | HttpRouter.Request<"Requires", ExtensionServices>
	>,
) =>
	Effect.gen(function* () {
		const routesLayer: Layer.Layer<
			never,
			E,
			ExtensionServices | HttpRouter.Request<"Requires", ExtensionServices> | HttpRouter.HttpRouter
		> = HttpApiBuilder.layer(definition).pipe(Layer.provide(handlers));
		const services = yield* Effect.context<ExtensionServices>();
		const built = yield* HttpRouter.toHttpEffect(routesLayer);
		const dispatch = built.pipe(
			Effect.provideContext(services),
			Effect.catchCause((cause): Effect.Effect<never, HttpServerError.HttpServerError | KernelError> => {
				const codes = cause.reasons.map((reason) =>
					reason._tag === "Interrupt"
						? undefined
						: requestErrorCode(reason._tag === "Fail" ? reason.error : reason.defect),
				);
				const code = codes[0];
				return code && codes.every((value) => value !== undefined)
					? Effect.fail(new KernelError({ code }))
					: Effect.failCause(cause);
			}),
		);
		const document = OpenApi.fromApi(definition);
		const routes = Object.entries(document.paths).flatMap(([path, item]) =>
			methods.flatMap((method) => {
				const details = operation(item, method);
				if (!details) return [];
				const route: `/${string}` = `/${path
					.slice(1)
					.replaceAll("{*}", "*")
					.replace(/\{([^}]+)\}/g, ":$1")}`;
				// HttpRouter registers a terminal wildcard at its base path as well.
				// The extension ownership matcher and discovery must expose both routes.
				const paths: ReadonlyArray<`/${string}`> = route.endsWith("/*") ? [route, `/${route.slice(1, -2)}`] : [route];
				return paths.map((path) => ({
					method,
					path,
					description: details.description ?? "",
					scope: method === "GET" || method === "HEAD" ? ("read" as const) : ("write" as const),
					handler: () =>
						(details.requestBody && method !== "GET" && method !== "HEAD"
							? boundedRequest(131072).pipe(
									Effect.flatMap((request) =>
										dispatch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
									),
								)
							: dispatch
						).pipe(Effect.map(HttpServerResponse.toWeb)),
					operation:
						path === route
							? details
							: {
									...details,
									operationId: `${details.operationId}.root`,
									parameters: details.parameters.filter(
										(parameter) => parameter.in !== "path" || parameter.name !== "*",
									),
								},
				}));
			}),
		);
		return { routes, document };
	});
