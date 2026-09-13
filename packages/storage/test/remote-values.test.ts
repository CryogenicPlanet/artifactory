import * as PgTypes from "@effect/sql-pg/PgTypes";
import { Result } from "effect";
import { expect, it } from "vitest";
import { hasUnsafeInteger, mysqlTypeCast, postgresTypes } from "../src/remote-values.ts";

it("decodes PostgreSQL int8 scalars and arrays exactly without changing global codecs", () => {
	const types = postgresTypes();
	for (const value of [0n, -1n, 9007199254740991n, -9007199254740991n]) {
		const bytes = Result.getOrThrow(PgTypes.encode(value, PgTypes.OID.int8));
		expect(Result.getOrThrow(PgTypes.decode(bytes, PgTypes.OID.int8, 1, types))).toBe(Number(value));
		expect(Result.getOrThrow(PgTypes.decode(bytes, PgTypes.OID.int8, 1))).toBe(value);
	}
	for (const value of [9007199254740992n, -9007199254740992n]) {
		const bytes = Result.getOrThrow(PgTypes.encode(value, PgTypes.OID.int8));
		expect(Result.isFailure(PgTypes.decode(bytes, PgTypes.OID.int8, 1, types))).toBe(true);
	}
	const bytes = Result.getOrThrow(PgTypes.encode([1n, null, 9007199254740991n], PgTypes.OID.int8Array));
	expect(Result.getOrThrow(PgTypes.decode(bytes, PgTypes.OID.int8Array, 1, types))).toEqual([
		1,
		null,
		9007199254740991,
	]);
});

it("leaves text, JSON and binary codecs intact", () => {
	const types = postgresTypes();
	for (const [oid, value] of [
		[PgTypes.OID.text, '{"counter":9007199254740993}'],
		[PgTypes.OID.bytea, new Uint8Array([0, 255, 128])],
	] as const) {
		const bytes = Result.getOrThrow(PgTypes.encode(value, oid));
		expect(Result.getOrThrow(PgTypes.decode(bytes, oid, 1, types))).toEqual(value);
	}
	const text = '{"counter":9007199254740993}';
	expect(mysqlTypeCast({ type: "JSON", string: () => null }, () => text)).toBe(text);
	expect(hasUnsafeInteger({ text, bytes: new Uint8Array([0, 255]) })).toBe(false);
});

it("returns safe MySQL BIGINT numbers and rejects lossless unsafe sentinels in every result shape", () => {
	for (const text of ["0", "-1", "9007199254740991", "-9007199254740991"]) {
		const value = mysqlTypeCast({ type: "LONGLONG", string: () => text }, () => text);
		expect(value).toBe(Number(text));
		expect(hasUnsafeInteger(value)).toBe(false);
	}
	for (const text of ["9007199254740992", "-9007199254740992", "18446744073709551615"]) {
		const value = mysqlTypeCast({ type: "LONGLONG", string: () => text }, () => text);
		expect(value).toBe(BigInt(text));
		for (const result of [value, [{ n: value }], [[value]], { insertId: Number(text) }])
			expect(hasUnsafeInteger(result)).toBe(true);
	}
	expect(mysqlTypeCast({ type: "LONGLONG", string: () => null }, () => null)).toBe(null);
});

it("preserves PostgreSQL JSON wire text, SQL nulls and arrays in each pool", () => {
	const types = postgresTypes();
	const text = ' { "n":9007199254740993, "x":"雪 🐘", "escaped":"\\u0061\\n" } ';
	for (const oid of [PgTypes.OID.json, PgTypes.OID.jsonb]) {
		const body = new TextEncoder().encode(text);
		const bytes = oid === PgTypes.OID.jsonb ? new Uint8Array([1, ...body]) : body;
		expect(Result.getOrThrow(PgTypes.decode(bytes, oid, 1, types))).toBe(text);
		const read = Result.getOrThrow(PgTypes.makeFieldReader([{ dataTypeOid: oid, format: 1 }], types));
		const framed = new Uint8Array([7, ...bytes, 8]);
		expect(read(framed, 1, bytes.length, 0)).toBe(text);
		expect(read(framed, 0, -1, 0)).toBe(null);
		const encoded = Result.getOrThrow(PgTypes.encode({ hello: "雪" }, oid, types));
		expect(encoded).toEqual(Result.getOrThrow(PgTypes.encode({ hello: "雪" }, oid)));
		expect(Result.getOrThrow(PgTypes.decode(encoded, oid, 1))).toEqual({ hello: "雪" });
		const arrayOid = oid === PgTypes.OID.json ? PgTypes.OID.jsonArray : PgTypes.OID.jsonbArray;
		const array = Result.getOrThrow(PgTypes.encode([{ hello: "雪" }, null], arrayOid));
		expect(Result.getOrThrow(PgTypes.decode(array, arrayOid, 1, types))).toEqual(['{"hello":"雪"}', null]);
	}
});

it("rejects an unknown JSONB version without exposing payload text", () => {
	for (const bytes of [new Uint8Array(), new Uint8Array([2, ...new TextEncoder().encode("secret-canary")])]) {
		const result = PgTypes.decode(bytes, PgTypes.OID.jsonb, 1, postgresTypes());
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure.message).toBe("remote_jsonb_version_invalid");
			expect(String(result.failure)).not.toContain("secret-canary");
		}
	}
});
