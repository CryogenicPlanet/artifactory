import { Schema, SchemaTransformation } from "effect";

/** Decimal query values decode to bounded integers; omission is handled by each route. */
export const queryInteger = (minimum: number, maximum: number) =>
	Schema.String.check(Schema.isPattern(/^[0-9]+$/))
		.annotate({
			description: `Decimal integer from ${minimum} through ${maximum}.`,
			contentMediaType: "application/json",
			contentSchema: { type: "integer", minimum, maximum },
		})
		.pipe(
			Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum, maximum })), SchemaTransformation.numberFromString),
		);

/**
 * Declared once, so a refusal can quote the bound it broke and the recipes can table them without
 * anyone fetching the schema. Exceeding one used to return query_invalid and a pointer at /api.
 */
export const queryBounds = {
	since: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
	limit: { minimum: 1, maximum: 200 },
	wait: { minimum: 0, maximum: 60 },
	depth: { minimum: 1, maximum: 200 },
} as const satisfies Record<string, { readonly minimum: number; readonly maximum: number }>;

export const QueryCursor = queryInteger(queryBounds.since.minimum, queryBounds.since.maximum);
export const QueryLimit = queryInteger(queryBounds.limit.minimum, queryBounds.limit.maximum);
export const QueryWait = queryInteger(queryBounds.wait.minimum, queryBounds.wait.maximum);
export const QueryDepth = queryInteger(queryBounds.depth.minimum, queryBounds.depth.maximum);

/** The sentence a refusal uses in place of "check /api", for the parameters that have a bound. */
export const queryBoundHint = (field: string): string | undefined => {
	const declared: Record<string, { readonly minimum: number; readonly maximum: number } | undefined> = queryBounds;
	const bound = declared[field];
	return bound === undefined
		? undefined
		: `${field} accepts a decimal integer from ${bound.minimum} through ${bound.maximum}.`;
};
