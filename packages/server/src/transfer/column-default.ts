import type { TransferColumn } from "@comms/storage/transfer-inventory";
import type { TransferEngine } from "./derived-schema.ts";

/** Compare only scalar literals. Executable defaults need trusted migration-specific equivalence,
 * not a parser which guesses whether arbitrary functions behave alike on another database. */
const literalDefault = (engine: TransferEngine, column: TransferColumn): string | undefined => {
	const value = column.default;
	// Identity generation has its own copy/reset contract; serial nextval is not an ordinary default.
	if (engine === "pg" && column.identity && typeof value === "string" && /^nextval\(/.test(value)) return "absent";
	if (value === null || value === undefined) return "absent";
	if (engine === "mysql" && column.kind === "text" && column.defaultExpression === false) return `text:${value}`;
	if (/^NULL(?:::(?:text|character varying|bigint|integer))?$/i.test(value)) return "absent";
	if (column.kind === "integer" && /^-?(?:0|[1-9][0-9]*)$/.test(value)) return `integer:${BigInt(value)}`;
	if (column.kind !== "text") return undefined;
	if (engine === "mysql" && column.defaultExpression === true) {
		// MySQL's canonical scalar-expression spelling, including the core [] defaults.
		// Only the catalog's delimiter escaping is accepted; no escapes inside the value.
		const scalar = /^_utf8mb4\\'([^'\\]*)\\'$/.exec(value);
		if (scalar?.[1] !== undefined) return `text:${scalar[1]}`;
	}
	// PostgreSQL emits a catalog type cast; SQLite retains SQL literal spelling. MySQL expression
	// defaults can contain a quoted literal, but functions and escape-dependent text are refused.
	const text = /^'((?:[^'\\]|'')*)'(?:::(?:text|character varying))?$/.exec(value);
	return text?.[1] === undefined ? undefined : `text:${text[1].replace(/''/g, "'")}`;
};

export const sameTransferDefault = (
	sourceEngine: TransferEngine,
	source: TransferColumn,
	targetEngine: TransferEngine,
	target: TransferColumn,
): boolean => {
	const left = literalDefault(sourceEngine, source);
	const right = literalDefault(targetEngine, target);
	return left !== undefined && right !== undefined && left === right;
};
