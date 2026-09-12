import { errorSchema, policy } from "@comms/protocol/errors";
import { templatePattern } from "./kernel/extension-routes.ts";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
interface RouteDescription {
	readonly extension: string;
	readonly method: HttpMethod;
	readonly path: `/${string}`;
	readonly description: string;
	readonly scope: string;
	readonly operation?: OpenApi.OpenAPISpecOperation;
}

export const description = (extensions: { readonly registrations: ReadonlyArray<RouteDescription> }) => {
	const endpoints = extensions.registrations.map((route, index) => {
		// OpenAPI requires one template per path shape, even when methods name parameters differently.
		const path =
			extensions.registrations.find((other) => templatePattern(other.path) === templatePattern(route.path))?.path ??
			route.path;
		return HttpApiEndpoint.make(route.method)(`extension${index}`, `/${path.slice(1).replace(/\*$/, "{*}")}`, {
			params: Schema.Struct(
				Object.fromEntries(
					path
						.split("/")
						.filter((part) => part.startsWith(":") || part === "*")
						.map((part) => [part === "*" ? "*" : part.slice(1), Schema.String]),
				),
			),
			success: Schema.Unknown,
			error: errorSchema("extension_disabled", policy.extension_disabled.status),
		}).annotate(
			OpenApi.Description,
			`${route.description}${path !== route.path ? ` Runtime pattern: ${route.path}.` : ""}${route.path.endsWith("/*") ? ' The {*} path parameter captures the remaining path (ctx.params["*"]).' : ""} Requires ${route.scope}. Extension: ${route.extension}.`,
		);
	});
	const group = HttpApiGroup.make("extensions");
	const first = endpoints[0];
	return first === undefined ? group : group.add(first, ...endpoints.slice(1));
};

/** Selected runtime ownership chooses the operation schema too; an override cannot leave stale core docs. */
export const document = (
	registrations: ReadonlyArray<RouteDescription>,
	documents: ReadonlyArray<OpenApi.OpenAPISpec>,
) => {
	const result = OpenApi.fromApi(HttpApi.make("extensions").add(description({ registrations })));
	const disabled = Object.values(result.paths)
		.flatMap(Object.values)
		.find((operation) => "responses" in operation)?.responses[500];
	for (const item of documents) {
		Object.assign(result.components.schemas, item.components.schemas);
		Object.assign(result.components.securitySchemes, item.components.securitySchemes);
	}
	for (const route of registrations) {
		if (!route.operation) continue;
		const canonical =
			registrations.find((other) => templatePattern(other.path) === templatePattern(route.path))?.path ?? route.path;
		const key = canonical.replace(/:([A-Za-z_]\w*)/g, "{$1}").replace(/\*$/, "{*}");
		const item = result.paths[key];
		if (item) {
			const existing = route.operation.responses[500];
			const disabledSchema = disabled?.content?.["application/json"]?.schema;
			const existingSchema = existing?.content?.["application/json"]?.schema;
			const responses = { ...route.operation.responses };
			if (disabled && disabledSchema)
				responses[500] = {
					...existing,
					description: existing?.description ?? disabled.description,
					content: {
						...existing?.content,
						"application/json": {
							schema: existingSchema ? { anyOf: [existingSchema, disabledSchema] } : disabledSchema,
						},
					},
				};
			Object.assign(item, {
				[route.method.toLowerCase()]: {
					...route.operation,
					responses,
					parameters: route.operation.parameters.map((parameter) => {
						if (parameter.in !== "path") return parameter;
						const index = route.path
							.split("/")
							.findIndex((segment) => segment === `:${parameter.name}` || (parameter.name === "*" && segment === "*"));
						const segment = canonical.split("/")[index];
						return segment === "*"
							? { ...parameter, name: "*" }
							: segment?.startsWith(":")
								? { ...parameter, name: segment.slice(1) }
								: parameter;
					}),
					description: `${route.description} Extension: ${route.extension}.`,
				},
			});
		}
	}
	return result;
};
