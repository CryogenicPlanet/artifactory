import { childErrorPolicy } from "../../../boot/src/child-error-policy.ts";

/** Only static diagnostic labels reach CI; fixture source, credentials and arbitrary error text stay private. */
export const shutdownFailureCodes = (text: string) =>
	[
		...Object.keys(childErrorPolicy),
		"SyntaxError",
		"TypeError",
		"ReferenceError",
		"SqlError",
		"StorageRejected",
		"EventStorageRejected",
		"app_store_identity_invalid",
		"app_store_identity_mismatch",
		"storage_headroom",
		"backup_budget",
		"ENOSPC",
		"ENOMEM",
		"EACCES",
		"permission denied",
		"out of memory",
	].filter((code) => text.includes(code));
