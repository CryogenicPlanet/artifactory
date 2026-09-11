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
			extensions.registrations.find(
				(other) =>
					other.path.replace(/:[A-Za-z_]\w*/g, ":parameter") === route.path.replace(/:[A-Za-z_]\w*/g, ":parameter"),
			)?.path ?? route.path;
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
	for (const item of documents) {
		Object.assign(result.components.schemas, item.components.schemas);
		Object.assign(result.components.securitySchemes, item.components.securitySchemes);
	}
	for (const route of registrations) {
		if (!route.operation) continue;
		const canonical =
			registrations.find(
				(other) =>
					other.path.replace(/:[A-Za-z_]\w*/g, ":parameter") === route.path.replace(/:[A-Za-z_]\w*/g, ":parameter"),
			)?.path ?? route.path;
		const key = canonical.replace(/:([A-Za-z_]\w*)/g, "{$1}").replace(/\*$/, "{*}");
		const item = result.paths[key];
		if (item)
			Object.assign(item, {
				[route.method.toLowerCase()]: {
					...route.operation,
					parameters: route.operation.parameters.map((parameter) => {
						if (parameter.in !== "path") return parameter;
						const index = route.path.split("/").findIndex((segment) => segment === `:${parameter.name}`);
						const segment = canonical.split("/")[index];
						return segment?.startsWith(":") ? { ...parameter, name: segment.slice(1) } : parameter;
					}),
					description: `${route.description} Extension: ${route.extension}.`,
				},
			});
	}
	return result;
};
