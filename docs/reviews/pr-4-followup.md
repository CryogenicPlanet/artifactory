# PR 4 follow-up at 7d47607

The review found that schema rung 18 could advance a v17 store with unfinished recovery, backup writers relied on a SQLite default, and rollback fabricated artifact provenance. The follow-up refuses that upgrade before schema changes, records the capture engine explicitly, returns complete backup metadata, and uses engine-specific paths consistently. It forwards the original decoded artifact to restore.

## Retention decision

Automatic backup quota and pruning apply to the currently selected engine. Foreign-engine artifacts and their catalog rows remain intact and do not consume that automatic quota. The physical filesystem headroom check still includes all used space, including foreign artifacts, before each copy. Switching engines does not authorize deleting old backups. Existing journal/generation protection and canonical-path checks still apply to current-engine artifacts.

This deliberately differs from SPEC.md §7.5 and docs/database.md §10.2, which describe the percentage budget as a budget on all backup artifact bytes on the volume. Keeping foreign artifacts inside that quota while refusing to prune them can permanently prevent the first backup on a new engine. The selected policy preserves those artifacts while allowing new backups whenever physical headroom permits. The owner-authored spec files are unchanged; this disagreement needs incorporation into the authoritative design.

## Remaining step-2 gaps

This follow-up does not complete the full planned DbOps surface: cloneForRehearsal/backup artifacts, explicit dropClone/reapClones, capacity, tableExists and readOnlySession remain separate work on this rung. restoreInto still returns void; callers retain the fixed SQLite descriptor rather than consuming a returned descriptor or recording an engine-neutral authority switch. Remote provisioning, native restore and cross-engine transfer are not implemented on this rung.

The copy follow-up moves SQLite VACUUM INTO into an immutable worker with a responsive keeper. REHEARSAL_COPY_BUDGET defaults to 30 seconds; the keeper enforces it independently of the boot event loop. Timeout and parent EOF require positive worker exit and process-group absence before a bound, synced receipt permits cleanup. Missing keeper proof retains the copy journal and files and blocks migration, restore, workspace cleanup and traffic resumption. Normal completed copies still belong to their caller; this does not implement a general orphan-artifact reaper.

Boot schema 19 is a protocol-compatibility stamp, with no new SQL table. The sqlite_copy setting records a possible open database owner; an old image that ignores it must refuse the store. Pending recovery refuses upgrades below the supported target before changing schema or journal mode. The later Migrator ladder must include a named version 19 compatibility operation rather than merely mirror the number.

The hourly aggregate ten-second and pre-flip aggregate thirty-second capture timers are removed; existing drain and child-health budgets remain separate. Copy timeout is a typed rehearsal_copy_timeout with a store-size/budget hint. This still does not implement the broader planned clone registry/capacity/read-only-session interfaces.

The descendant helper remains on this rung; the one unconverted sibling in the same topic query now uses it. The broad dialect conversion belongs to the next rung.

Validation: six focused copy lifecycle tests pass, including committed WAL data, timeout, boot SIGKILL, missing keeper proof, Effect interruption and an emulated older schema ceiling. Twenty-three identity and backup metadata tests pass, including pending v18 recovery refusal. Tests ran with Node 22.22.3 and one Vitest worker; subprocess fixtures use Bun. Full check and build pass. The older-ceiling test emulates version 18 support; it does not launch a released older image. Full combined-stack acceptance remains an integration check.
