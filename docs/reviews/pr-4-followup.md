# PR 4 follow-up at 7d47607

The review found that schema rung 18 could advance a v17 store with unfinished recovery, backup writers relied on a SQLite default, and rollback fabricated artifact provenance. The follow-up refuses that upgrade before schema changes, records the capture engine explicitly, returns complete backup metadata, and uses engine-specific paths consistently. It forwards the original decoded artifact to restore.

## Retention decision

Automatic backup quota and pruning apply to the currently selected engine. Foreign-engine artifacts and their catalog rows remain intact and do not consume that automatic quota. The physical filesystem headroom check still includes all used space, including foreign artifacts, before each copy. Switching engines does not authorize deleting old backups. Existing journal/generation protection and canonical-path checks still apply to current-engine artifacts.

This deliberately differs from SPEC.md §7.5 and docs/database.md §10.2, which describe the percentage budget as a budget on all backup artifact bytes on the volume. Keeping foreign artifacts inside that quota while refusing to prune them can permanently prevent the first backup on a new engine. The selected policy preserves those artifacts while allowing new backups whenever physical headroom permits. The owner-authored spec files are unchanged; this disagreement needs incorporation into the authoritative design.

## Remaining step-2 gaps

This follow-up does not complete the full planned DbOps surface: cloneForRehearsal/backup artifacts, explicit dropClone/reapClones, capacity, tableExists and readOnlySession remain separate work on this rung. restoreInto still returns void; callers retain the fixed SQLite descriptor rather than consuming a returned descriptor or recording an engine-neutral authority switch. Remote provisioning, native restore and cross-engine transfer are not implemented on this rung.

A hard SQLite copy deadline also remains open. The pinned Effect SQLite Bun driver calls statement.all synchronously, so VACUUM INTO blocks the event loop. Adding Effect.timeout alone cannot bound that operation. The copy must move to an isolated execution process with positively awaited exit before cleanup. The existing hourly aggregate ten-second deadline and unbounded rehearsal copy do not satisfy the separate copy budget in docs/database.md §5.3. A follow-up must separate copy and health/drain deadlines without treating cancellation as proof of handle closure.

The descendant helper remains on this rung; the one unconverted sibling in the same topic query now uses it. The broad dialect conversion belongs to the next rung.
