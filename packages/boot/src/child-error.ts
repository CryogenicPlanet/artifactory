import { Schema } from "effect";

export class ChildError extends Schema.TaggedError<ChildError>()("ChildError", {
	code: Schema.Literals([
		"accepted_snapshot_missing",
		"rehearsal_copy_timeout",
		"sqlite_copy_failed",
		"sqlite_copy_invalid",
		"sqlite_copy_closure_unproven",
		"backup_live_child_required",
		"boot_shutting_down",
		"child_closure_unproven",
		"child_control_failed",
		"child_exited",
		"child_receipt_invalid",
		"child_unresponsive",
		"cutover_backup_invalid",
		"cutover_backup_missing",
		"cutover_recovery_required",
		"generation_store_incompatible",
		"health_failed",
		"incompatible_schema",
		"keeper_closure_unproven",
		"preparation_build_failed",
		"preparation_build_timeout",
		"preparation_group_closure_unproven",
		"preparation_group_probe_failed",
		"preparation_install_failed",
		"preparation_install_timeout",
		"restore_backup_changed",
		"restore_backup_invalid",
		"backup_engine_mismatch",
		"restore_record_missing",
		"restore_recovery_required",
		"restore_rehearsal_failed",
		"restore_safety_backup_missing",
		"restore_snapshot_missing",
	]),
	stderr: Schema.optionalKey(Schema.String),
}) {
	get message() {
		return `Child operation failed: ${this.code}`;
	}
}
