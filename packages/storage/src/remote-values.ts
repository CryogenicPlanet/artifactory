import * as PgTypes from "@effect/sql-pg/PgTypes";
import { Result } from "effect";

/** Each pool owns its registry; never change the driver's process-wide codecs. */
export const postgresTypes = () => {
	const registry = PgTypes.makeRegistry();
	const utf8 = new TextDecoder();
	for (const oid of [PgTypes.OID.json, PgTypes.OID.jsonb]) {
		registry.register(oid, {
			encode: (value: unknown) => PgTypes.encode(value, oid),
			decode: (bytes) => {
				if (oid === PgTypes.OID.jsonb && bytes[0] !== 1)
					return Result.fail(new PgTypes.CodecError({ message: "remote_jsonb_version_invalid" }));
				return Result.succeed(utf8.decode(oid === PgTypes.OID.jsonb ? bytes.subarray(1) : bytes));
			},
		});
	}
	registry.register(PgTypes.OID.int8, {
		encode: (value: unknown) => PgTypes.encode(value, PgTypes.OID.int8),
		decode: (bytes) =>
			Result.flatMap(PgTypes.decode(bytes, PgTypes.OID.int8, 1), (value) => {
				const number = typeof value === "bigint" ? Number(value) : NaN;
				return Number.isSafeInteger(number)
					? Result.succeed(number)
					: Result.fail(new PgTypes.CodecError({ message: "remote_integer_out_of_range" }));
			}),
	});
	return registry;
};

/** Keep unsafe integers lossless until the guarded connection rejects its result.
 * Throwing from mysql2's parser callback can escape the query's Effect. */
export const mysqlTypeCast = (
	field: { readonly type: string; readonly string: () => string | null },
	next: () => unknown,
) => {
	if (field.type !== "LONGLONG") return next();
	const text = next();
	if (typeof text !== "string") return text;
	const number = Number(text);
	return Number.isSafeInteger(number) ? number : BigInt(text);
};

/** mysql2 raw results include insertId; never let a rounded integer escape that path either. */
export const hasUnsafeInteger = (value: unknown): boolean => {
	if (typeof value === "bigint") return true;
	if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
	if (value instanceof Uint8Array || value instanceof Date) return false;
	if (Array.isArray(value)) return value.some(hasUnsafeInteger);
	if (value !== null && typeof value === "object") return Object.values(value).some(hasUnsafeInteger);
	return false;
};
