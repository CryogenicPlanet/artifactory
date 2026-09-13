import { Effect } from "effect";
import { KernelError } from "./boot-channel.ts";

const identifier = '(?:[a-zA-Z_][a-zA-Z0-9_]*|"[a-zA-Z_][a-zA-Z0-9_]*"|`[a-zA-Z_][a-zA-Z0-9_]*`)';
const table = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
const name = (target: string) =>
	target
		.split(".")
		.at(-1)
		?.trim()
		.replace(/^["`]|["`]$/g, "")
		.toLowerCase() ?? "";

/** MySQL DDL cannot rely on rollback. Refuse unsupported target grammar before creating an intent. */
export const mysqlMigrationTargets = (statement: string) =>
	Effect.gen(function* () {
		if (!/^\s*(?:CREATE|ALTER|DROP)\b/i.test(statement)) return [];
		const drop = new RegExp(
			`^\\s*DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${table}(?:\\s*,\\s*${table})*)(?:\\s+(?:RESTRICT|CASCADE))?\\s*$`,
			"i",
		).exec(statement);
		if (drop?.[1]) return drop[1].split(",").map(name);
		const rename = new RegExp(
			`^\\s*ALTER\\s+TABLE\\s+(${table})\\s+RENAME\\s+(?:(?:TO|AS)\\s+)?(${table})\\s*$`,
			"i",
		).exec(statement);
		if (rename?.[1] && rename[2]) return [name(rename[1]), name(rename[2])];
		// Multi-action table renames are outside this bounded DDL surface, even from an unprotected source.
		if (/^\s*ALTER\s+TABLE\b/i.test(statement) && /\bRENAME\b(?!\s+(?:COLUMN|INDEX|KEY)\b)/i.test(statement))
			return yield* new KernelError({ code: "extension_migration_invalid" });
		for (const expression of [
			`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${table})\\s*(?:\\(|LIKE\\b|AS\\s+SELECT\\b|SELECT\\b)`,
			`^\\s*ALTER\\s+TABLE\\s+(${table})\\s+(?:ADD|ALTER|CHANGE|MODIFY|DROP|RENAME|CONVERT|DEFAULT|CHARACTER|COLLATE|ENGINE|ALGORITHM|LOCK|FORCE|ENABLE|DISABLE|ORDER|PARTITION|REMOVE|EXCHANGE|IMPORT|DISCARD)\\b`,
			`^\\s*CREATE\\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\\s+)?INDEX\\s+${identifier}\\s+ON\\s+(${table})\\s*\\(`,
			`^\\s*DROP\\s+INDEX\\s+${identifier}\\s+ON\\s+(${table})(?:\\s|$)`,
		]) {
			const match = new RegExp(expression, "i").exec(statement);
			if (match?.[1]) return [name(match[1])];
		}
		return yield* new KernelError({ code: "extension_migration_invalid" });
	});
