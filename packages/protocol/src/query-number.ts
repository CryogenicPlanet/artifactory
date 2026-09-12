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

export const QueryCursor = queryInteger(0, Number.MAX_SAFE_INTEGER);
export const QueryLimit = queryInteger(1, 200);
