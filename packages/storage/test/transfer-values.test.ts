import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
	decodeTransferValue,
	digestTransferRows,
	makeTransferDigest,
	type TransferValue,
} from "../src/transfer-values.ts";

const digest = (rows: Iterable<readonly TransferValue[]>) =>
	Effect.runPromise(digestTransferRows(rows).pipe(Effect.provide(BunCrypto.layer)));

it("retains exact large integers and refuses already-rounded or ambiguous values", async () => {
	for (const raw of [9223372036854775807n, "9223372036854775807"]) {
		expect(await Effect.runPromise(decodeTransferValue("integer", raw))).toEqual({
			kind: "integer",
			value: 9223372036854775807n,
		});
	}
	for (const raw of [9007199254740992, 1.1, NaN, Infinity, true, undefined, "01", "1e3", "1.0", " 1", "+1"]) {
		expect(await Effect.runPromise(decodeTransferValue("integer", raw).pipe(Effect.result))).toMatchObject({
			_tag: "Failure",
			failure: { code: "transfer_value_invalid" },
		});
	}
	expect(await digest([[{ kind: "integer", value: 42 }]])).toBe(await digest([[{ kind: "integer", value: 42n }]]));
});

it("preserves arbitrary bytes, including zero and invalid UTF-8, without retaining mutable driver buffers", async () => {
	const raw = new Uint8Array([0, 255, 192, 128, 0, 254]);
	const decoded = await Effect.runPromise(decodeTransferValue("bytes", raw));
	raw.fill(42);
	expect(decoded).toEqual({ kind: "bytes", value: new Uint8Array([0, 255, 192, 128, 0, 254]) });
	expect(await digest([[decoded]])).not.toBe(await digest([[{ kind: "bytes", value: new Uint8Array([0, 255]) }]]));
	for (const wrong of ["\\x00ffc08000fe", "\u0000ÿ", [0, 255], new ArrayBuffer(2)]) {
		expect(await Effect.runPromise(decodeTransferValue("bytes", wrong).pipe(Effect.result))).toMatchObject({
			_tag: "Failure",
			failure: { code: "transfer_value_invalid" },
		});
	}
});

it("refuses lossy Unicode and invalid JSON representations without revealing contents", async () => {
	for (const value of ["secret\ud800", "\udc00secret", "a\ud800z"]) {
		const result = await Effect.runPromise(decodeTransferValue("text", value).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "transfer_value_invalid" } });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
	expect(await Effect.runPromise(decodeTransferValue("text", "日本語😀\u0000é"))).toEqual({
		kind: "text",
		value: "日本語😀\u0000é",
	});
	for (const value of ['{"secret":', { n: 9007199254740992 }]) {
		expect(await Effect.runPromise(decodeTransferValue("json", value).pipe(Effect.result))).toMatchObject({
			_tag: "Failure",
			failure: { code: "transfer_json_invalid" },
		});
	}
});

it("frames cells, rows, nulls and kinds so concatenation cannot hide missing or altered data", async () => {
	const text = (value: string): TransferValue => ({ kind: "text", value });
	const cases: readonly (readonly (readonly TransferValue[])[])[] = [
		[],
		[[]],
		[[], []],
		[[text("")]],
		[[{ kind: "null", value: null }]],
		[[{ kind: "bytes", value: new Uint8Array() }]],
		[[text("ab"), text("c")]],
		[[text("a"), text("bc")]],
		[[text("a")], [text("bc")]],
		[[text("bc")], [text("a")]],
		[[{ kind: "integer", value: 1 }]],
		[[{ kind: "real", value: 1 }]],
		[[text("1")]],
		[[text("é")]],
		[[text("e\u0301")]],
	];
	const results = await Promise.all(cases.map(digest));
	expect(new Set(results).size).toBe(cases.length);
	expect(await digest([[text("ab"), text("c")]])).toBe(results[6]);
	for (const result of results) expect(result).toMatch(/^[0-9a-f]{64}$/);
});

it("preserves signed real zero and rejects nonfinite values even when handed a structural typed value", async () => {
	expect(Object.is((await Effect.runPromise(decodeTransferValue("real", -0))).value, -0)).toBe(true);
	expect(await digest([[{ kind: "real", value: -0 }]])).not.toBe(await digest([[{ kind: "real", value: 0 }]]));
	for (const value of [NaN, Infinity, -Infinity]) {
		expect(
			await Effect.runPromise(
				digestTransferRows([[{ kind: "real", value }]]).pipe(Effect.provide(BunCrypto.layer), Effect.result),
			),
		).toMatchObject({ _tag: "Failure", failure: { code: "transfer_value_invalid" } });
	}
});

it("preserves raw JSON binds while hashing exact semantic numbers and object order", async () => {
	const hash = async (text: string) => digest([[await Effect.runPromise(decodeTransferValue("json", text))]]);
	for (const [a, b] of [
		[' {"b":1.00,"a":"\\u96ea"} ', '{"a":"雪","b":1e0}'],
		["[9007199254740993, 0.00100, -0]", "[90071992547409930e-1, 1e-3, 0]"],
		["1e9999999999999999999999", "10e9999999999999999999998"],
		['{"__proto__": {"x":1}, "a":true}', '{"a":true,"__proto__":{"x":1.0}}'],
	] as const) {
		expect(await Effect.runPromise(decodeTransferValue("json", a))).toEqual({ kind: "json", value: a });
		expect(await hash(a)).toBe(await hash(b));
	}
	for (const [a, b] of [
		["9007199254740993", "9007199254740992"],
		["[1,2]", "[2,1]"],
		['"é"', '"é"'],
		["null", '"null"'],
	])
		expect(await hash(a ?? "")).not.toBe(await hash(b ?? ""));
	expect(await hash("null")).not.toBe(await digest([[await Effect.runPromise(decodeTransferValue("json", null))]]));
	expect(await hash("1")).not.toBe(await digest([[await Effect.runPromise(decodeTransferValue("text", "1"))]]));
	expect(await digest([[await Effect.runPromise(decodeTransferValue("text", '{"a":1}'))]])).not.toBe(
		await digest([[await Effect.runPromise(decodeTransferValue("text", '{ "a":1 }'))]]),
	);
});

it("refuses duplicate keys and malformed JSON before verification without leaking contents", async () => {
	for (const text of ['{"secret":1,"secret":2}', '{"x":1,"\\u0078":2}']) {
		const result = await Effect.runPromise(decodeTransferValue("json", text).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "transfer_json_duplicate_key" } });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
	for (const text of [
		"[1,]",
		'{"a":1,}',
		"01",
		"1e",
		"true false",
		'"\\ud800"',
		"[secret]",
		"[".repeat(130) + "]".repeat(130),
	]) {
		const result = await Effect.runPromise(decodeTransferValue("json", text).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "transfer_json_invalid" } });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
});

it("incremental digests match whole input, repeat finish and reject rows atomically", async () => {
	const rows: readonly (readonly TransferValue[])[] = [
		[{ kind: "json", value: '{"n":1.00}' }],
		[{ kind: "text", value: "immutable" }],
	];
	await Effect.runPromise(
		Effect.gen(function* () {
			const chain = yield* makeTransferDigest;
			const other = yield* makeTransferDigest;
			const empty = yield* chain.finish;
			for (const row of rows) yield* chain.append(row);
			const expected = yield* digestTransferRows(rows);
			expect(yield* chain.finish).toBe(expected);
			expect(yield* chain.finish).toBe(expected);
			expect(yield* other.finish).toBe(empty);
			expect(
				(yield* chain
					.append([
						{ kind: "text", value: "valid" },
						{ kind: "json", value: '{"bad":' },
					])
					.pipe(Effect.result))._tag,
			).toBe("Failure");
			expect(yield* chain.finish).toBe(expected);
		}).pipe(Effect.provide(BunCrypto.layer)),
	);
});
