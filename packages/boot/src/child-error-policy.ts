import type { ChildError } from "./child-process.ts";

const recovery = {
	status: 409,
	retriable: false,
	hint: "Inspect /_boot/status and keeper or recovery evidence. Repair the reported condition before retrying; a timeout is not closure proof.",
} as const;
const source = {
	status: 409,
	retriable: false,
	hint: "Inspect /_boot/status, repair staged source or dependencies, then rehearse a new reload.",
} as const;
const unavailable = {
	status: 503,
	retriable: true,
	hint: "Wait for boot startup or shutdown to finish, then retry the unchanged request.",
} as const;
/** Exhaustive child failures shared by boot HTTP boundaries; recovery evidence is never a retry loop. */
export const childErrorPolicy = {
	accepted_snapshot_missing: recovery,
	sqlite_copy_failed: recovery,
	sqlite_copy_invalid: recovery,
	sqlite_copy_closure_unproven: recovery,
	rehearsal_copy_timeout: {
		status: 409,
		retriable: false,
		hint: "Increase REHEARSAL_COPY_BUDGET for this store size, then retry. The copy exceeded its budget; this is not an edited-source health failure.",
	},
	backup_live_child_required: unavailable,
	boot_shutting_down: unavailable,
	child_closure_unproven: recovery,
	child_control_failed: source,
	child_exited: source,
	child_receipt_invalid: recovery,
	child_unresponsive: source,
	cutover_backup_invalid: recovery,
	cutover_backup_missing: recovery,
	cutover_recovery_required: recovery,
	generation_store_incompatible: {
		status: 409,
		retriable: false,
		hint: "This saved source does not declare support for the selected database engine. Update its APP_STORE implementation and comms.storage_engines in package.json, then rehearse a new generation; old snapshots remain SQLite-only.",
	},
	health_failed: source,
	incompatible_schema: {
		status: 409,
		retriable: false,
		hint: "Apply a forward source fix compatible with current data, or ask the human to authorize a combined source/database restore.",
	},
	keeper_closure_unproven: recovery,
	preparation_build_failed: source,
	preparation_build_timeout: source,
	preparation_group_closure_unproven: recovery,
	preparation_group_probe_failed: recovery,
	preparation_install_failed: source,
	preparation_install_timeout: source,
	restore_backup_changed: recovery,
	restore_backup_invalid: recovery,
	backup_engine_mismatch: {
		status: 409,
		retriable: false,
		hint: "Choose a backup created by this deployment’s database engine.",
	},
	restore_record_missing: recovery,
	restore_recovery_required: recovery,
	restore_rehearsal_failed: source,
	restore_safety_backup_missing: recovery,
	restore_snapshot_missing: recovery,
} as const satisfies Readonly<
	Record<ChildError["code"], { readonly status: number; readonly retriable: boolean; readonly hint: string }>
>;
