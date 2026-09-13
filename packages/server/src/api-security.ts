import { scopesHeader } from "@comms/protocol/headers";
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi";

export type RouteScope = "read" | "write" | "fs";

/**
 * The schemes boot's manifest declares and discovery.ts merges into /api's components. Every app
 * operation rejects an unauthenticated call at runtime, so the document has to say so: a client
 * generated from `"security": []` ships with no credentials and fails on first contact.
 */
const credentials: ReadonlyArray<Record<string, ReadonlyArray<string>>> = [
	{ commsBootSession: [] },
	{ commsBootAccess: [] },
];

const secured = (operation: object, scope: RouteScope | "public") => ({
	...operation,
	security: scope === "public" ? [] : credentials.map((scheme) => ({ ...scheme })),
	[scopesHeader]: scope === "public" ? [] : [scope],
});

/**
 * Declare, per operation, the credentials it accepts and the scope it needs, matching the
 * `security` and scopes boot already publishes for its own routes. The spec is assembled
 * by mutation here and in the extension document, so this stamps in place too.
 */
export const applySecurity = (
	paths: OpenAPISpec["paths"],
	scopeOf: (path: string, method: string) => RouteScope | "public" | undefined,
): void => {
	for (const [path, item] of Object.entries(paths))
		for (const [method, operation] of Object.entries(item)) {
			const scope = scopeOf(path, method);
			if (scope !== undefined && typeof operation === "object" && operation !== null)
				Object.assign(item, { [method]: secured(operation, scope) });
		}
};
