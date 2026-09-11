import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import type { Extensions } from "./kernel/ext.ts";

export const description = (extensions: Extensions["Service"]) =>
	HttpApiGroup.make("extensions").add(
		HttpApiEndpoint.get("extensions", "/api/ext", { success: Schema.Unknown }).annotate(
			OpenApi.Description,
			"List loaded extensions, registrations and failures. Requires read.",
		),
		...extensions.registrations.map((route, index) => {
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
		}),
	);
