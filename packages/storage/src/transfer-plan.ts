import { Schema } from "effect";
import type { TransferKind } from "./transfer-values.ts";

export type TransferEngine = "sqlite" | "pg" | "mysql";
/** Reviewed logical projection. Nullable describes destination admissibility. */
export interface TransferTablePlan {
	readonly name: string;
	readonly columns: readonly { readonly name: string; readonly kind: TransferKind; readonly nullable: boolean }[];
	readonly key: readonly string[];
	readonly identities: readonly string[];
}
export interface TransferTableManifest {
	readonly rows: number;
	readonly digest: string;
	readonly identities: readonly { readonly column: string; readonly maximum: string | null }[];
}
export class TransferCopyError extends Schema.TaggedError<TransferCopyError>()("TransferCopyError", {
	code: Schema.Literals([
		"transfer_plan_invalid",
		"transfer_value_invalid",
		"transfer_target_not_empty",
		"transfer_digest_mismatch",
		"transfer_query_failed",
	]),
}) {}
