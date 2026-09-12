import { Cause, Schema } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { KernelError } from "./boot-channel.ts";

/** Health diagnostics contain categories only, never driver messages or extension causes. */
export const healthFailure = (stage: "probe" | "initialize", cause: Cause.Cause<unknown>): string => {
	let code = "unknown_failure";
	for (const reason of cause.reasons) {
		if (!Cause.isFailReason(reason)) continue;
		if (Schema.is(KernelError)(reason.error)) {
			code = reason.error.code;
			break;
		}
		if (isSqlError(reason.error)) code = "sql_failure";
	}
	return `Kernel health failed: stage=${stage}; code=${code}`;
};
