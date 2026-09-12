import { Effect, Schema } from "effect";

export class TransferJsonError extends Schema.TaggedError<TransferJsonError>()("TransferJsonError", {
	code: Schema.Literals(["transfer_json_invalid", "transfer_json_duplicate_key"]),
}) {}
const invalid = () => new TransferJsonError({ code: "transfer_json_invalid" });

/** Canonical verification only; callers bind the original JSON text, never this representation.
 * Decimal coefficients/exponents stay strings and bigint. No JSON number passes through Number.
 * Duplicate keys and excessive nesting refuse rather than choosing engine-specific semantics. */
export const transferJsonCanonical = (source: string) =>
	Effect.try({
		try: () => {
			if (!source.isWellFormed()) throw invalid();
			let at = 0;
			const space = () => {
				while (/\s/.test(source[at] ?? "") && at < source.length) {
					if (!" \t\r\n".includes(source[at] ?? "")) throw invalid();
					at++;
				}
			};
			const string = (): string => {
				const token = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(source.slice(at))?.[0];
				if (!token) throw invalid();
				at += token.length;
				const value: unknown = JSON.parse(token);
				if (typeof value !== "string" || !value.isWellFormed()) throw invalid();
				return value;
			};
			const value = (depth: number): string => {
				if (depth > 128) throw invalid();
				space();
				const first = source[at];
				if (first === '"') return JSON.stringify(string());
				if (first === "[") {
					at++;
					space();
					const parts: string[] = [];
					if (source[at] !== "]")
						while (true) {
							parts.push(value(depth + 1));
							space();
							if (source[at] !== ",") break;
							at++;
						}
					if (source[at++] !== "]") throw invalid();
					return `[${parts.join(",")}]`;
				}
				if (first === "{") {
					at++;
					space();
					const parts = new Map<string, string>();
					if (source[at] !== "}")
						while (true) {
							space();
							const key = string();
							space();
							if (source[at++] !== ":") throw invalid();
							if (parts.has(key)) throw new TransferJsonError({ code: "transfer_json_duplicate_key" });
							parts.set(key, value(depth + 1));
							space();
							if (source[at] !== ",") break;
							at++;
						}
					if (source[at++] !== "}") throw invalid();
					return `{${[...parts]
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, entry]) => `${JSON.stringify(key)}:${entry}`)
						.join(",")}}`;
				}
				const literal = /^(true|false|null)/.exec(source.slice(at))?.[0];
				if (literal) {
					at += literal.length;
					return literal;
				}
				const number = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/.exec(source.slice(at));
				if (!number) throw invalid();
				at += number[0].length;
				const fraction = number[3] ?? "";
				let coefficient = `${number[2]}${fraction}`.replace(/^0+/, "");
				if (!coefficient) return "0";
				let exponent = BigInt(number[4] ?? "0") - BigInt(fraction.length);
				const trailing = /0+$/.exec(coefficient)?.[0].length ?? 0;
				if (trailing) {
					coefficient = coefficient.slice(0, -trailing);
					exponent += BigInt(trailing);
				}
				return `${number[1]}${coefficient}e${exponent}`;
			};
			const result = value(0);
			space();
			if (at !== source.length) throw invalid();
			return result;
		},
		catch: (error) => (Schema.is(TransferJsonError)(error) ? error : invalid()),
	});
