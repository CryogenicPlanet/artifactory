import { expect } from "vitest";

/** The refusal schemas are hoisted into components, so follow the reference before matching. */
export const refusalSchema = (
	document: {
		readonly components: { readonly schemas: Record<string, unknown> };
	},
	response: unknown,
): string => {
	const content = response as {
		readonly content?: Record<string, { readonly schema?: { readonly $ref?: string } }>;
	};
	const reference = content.content?.["application/json"]?.schema?.$ref;
	expect(reference, JSON.stringify(response)).toMatch(/^#\/components\/schemas\//);
	const name = (reference ?? "").slice("#/components/schemas/".length);
	expect(document.components.schemas).toHaveProperty(name);
	return JSON.stringify(document.components.schemas[name]);
};
