import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { decodeTransferValue, digestTransferRows, type TransferValue } from "../src/transfer-values.ts";

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

it("refuses lossy Unicode and unsupported native JSON without revealing contents", async () => {
	for (const value of ["secret\ud800", "\udc00secret", "a\ud800z"]) {
		const result = await Effect.runPromise(decodeTransferValue("text", value).pipe(Effect.result));
		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "transfer_value_invalid" } });
		expect(JSON.stringify(result)).not.toContain("secret");
	}
	expect(await Effect.runPromise(decodeTransferValue("text", "日本語😀\u0000é"))).toEqual({
		kind: "text",
		value: "日本語😀\u0000é",
	});
	for (const value of ['{"n":9007199254740993}', { n: 9007199254740992 }, null]) {
		expect(await Effect.runPromise(decodeTransferValue("json", value).pipe(Effect.result))).toMatchObject({
			_tag: "Failure",
			failure: { code: "transfer_json_unsupported" },
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
