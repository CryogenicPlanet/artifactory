import { TransferInventoryError, type TransferDerivedObject } from "@comms/storage/transfer-inventory";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { postgresSearchMode, postgresSearchShape } from "../ext/core/core-search-schema.ts";

const declaration = (
	name: string,
	body: string,
	language: string,
	returns: string,
	volatility: string,
	strict: boolean,
	parallel: string,
	binary: string | null,
	config: readonly string[] | null,
): TransferDerivedObject => ({
	name,
	kind: "function",
	definition: JSON.stringify([language, body, binary, volatility, strict, parallel, false, false, 0, returns, config]),
});
export const searchFunctionNames = [
	"public.comms_unaccent(text)",
	"public.unaccent(regdictionary, text)",
	"public.unaccent(text)",
	"public.unaccent_init(internal)",
	"public.unaccent_lexize(internal, internal, internal, internal)",
] as const;
/** Fixed migration12 definitions, never learned from arbitrary source function bodies. Target replay and ledger comparison remain mandatory. */
export const postgresSearchDeclarations = (sql: SqlClient) =>
	Effect.gen(function* () {
		const mode = yield* postgresSearchMode(sql);
		if (mode === "absent") return [];
		const ledger = yield* sql`SELECT migration_id,name FROM core_migrations WHERE migration_id=12`;
		if (ledger.length !== 1 || ledger[0]?.name !== "search_diacritics" || !(yield* postgresSearchShape(sql)))
			return yield* new TransferInventoryError({ code: "transfer_object_unsupported", object: "search_diacritics" });
		const result = [
			declaration(
				searchFunctionNames[0],
				mode === "folded"
					? "SELECT public.unaccent('public.unaccent'::pg_catalog.regdictionary, value)"
					: "SELECT value",
				"sql",
				"text",
				"i",
				false,
				"u",
				null,
				["search_path=pg_catalog"],
			),
		];
		if (mode === "folded")
			result.push(
				declaration(searchFunctionNames[1], "unaccent_dict", "c", "text", "s", true, "s", "$libdir/unaccent", null),
				declaration(searchFunctionNames[2], "unaccent_dict", "c", "text", "s", true, "s", "$libdir/unaccent", null),
				declaration(
					searchFunctionNames[3],
					"unaccent_init",
					"c",
					"internal",
					"v",
					false,
					"s",
					"$libdir/unaccent",
					null,
				),
				declaration(
					searchFunctionNames[4],
					"unaccent_lexize",
					"c",
					"internal",
					"v",
					false,
					"s",
					"$libdir/unaccent",
					null,
				),
			);
		return result;
	});
