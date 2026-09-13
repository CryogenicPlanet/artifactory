import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every operation declares the same error union, and inlining it made the refusal schemas most of
 * GET /api by weight. Each distinct shape becomes one component, referenced wherever it is used.
 * The document's meaning is unchanged: a $ref to a schema is that schema.
 */
export const hoistErrorSchemas = (spec: {
	readonly paths: OpenAPISpec["paths"];
	readonly components: { schemas: Record<string, unknown> };
}): void => {
	const named = new Map<string, string>();
	const reference = (status: string, schema: unknown) => {
		const shape = JSON.stringify(schema);
		const existing = named.get(shape);
		if (existing !== undefined) return existing;
		const base = `ErrorEnvelope${status}`;
		let name = base;
		for (let index = 2; Object.hasOwn(spec.components.schemas, name); index++) name = `${base}_${index}`;
		named.set(shape, name);
		spec.components.schemas[name] = schema;
		return name;
	};
	for (const item of Object.values(spec.paths)) {
		if (!isRecord(item)) continue;
		for (const [method, operation] of Object.entries(item)) {
			if (!isRecord(operation) || !isRecord(operation.responses)) continue;
			const responses = Object.fromEntries(
				Object.entries(operation.responses).map(([status, response]) => {
					// Success bodies differ per operation, and an existing reference is already hoisted.
					if (Number(status) < 400 || !isRecord(response)) return [status, response];
					const content = response.content;
					if (!isRecord(content)) return [status, response];
					const json = content["application/json"];
					if (!isRecord(json) || json.schema === undefined || (isRecord(json.schema) && "$ref" in json.schema))
						return [status, response];
					return [
						status,
						{
							...response,
							content: {
								...content,
								"application/json": {
									...json,
									schema: { $ref: `#/components/schemas/${reference(status, json.schema)}` },
								},
							},
						},
					];
				}),
			);
			Object.assign(item, { [method]: { ...operation, responses } });
		}
	}
};
