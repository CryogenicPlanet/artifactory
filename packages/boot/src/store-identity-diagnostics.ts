import { Schema } from "effect";

const StoreId = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/)),
);

/** Malformed store content must not become a path, credential or arbitrary diagnostic string. */
export const safeStoreId = (value: unknown): string | null => (Schema.is(StoreId)(value) ? value : null);

export const StoreIdentityDiagnostic = Schema.Struct({
	expected_store_id: Schema.NullOr(StoreId),
	observed_store_id: Schema.NullOr(StoreId),
});

export const storeIdentityDiagnostic = (expected: unknown, observed: unknown) => ({
	expected_store_id: safeStoreId(expected),
	observed_store_id: safeStoreId(observed),
});
