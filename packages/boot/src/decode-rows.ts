import { Effect, Schema } from "effect";

/** Decode SQL rows in the caller's existing effect and transaction scope. */
export const decodeRows = <S extends Schema.Constraint>(row: S) =>
	Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row)));
