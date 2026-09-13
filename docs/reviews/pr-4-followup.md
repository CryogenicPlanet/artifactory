# PR 4 review disposition

The review found that schema rung 18 could advance a v17 store with unfinished recovery, backup writers relied on a SQLite default, and rollback fabricated artifact provenance. The follow-up refuses that upgrade before schema changes, records the capture engine explicitly, returns complete backup metadata, and uses engine-specific paths consistently. It forwards the original decoded artifact to restore.

## Retention decision

Automatic backup quota and pruning apply to the currently selected engine. Foreign-engine artifacts and their catalog rows remain intact and do not consume that automatic quota. The physical filesystem headroom check still includes all used space, including foreign artifacts, before each copy. Switching engines does not authorize deleting old backups. Existing journal/generation protection and canonical-path checks still apply to current-engine artifacts.

This deliberately differs from SPEC.md §7.5 and docs/database.md §10.2, which describe the percentage budget as a budget on all backup artifact bytes on the volume. Keeping foreign artifacts inside that quota while refusing to prune them can permanently prevent the first backup on a new engine. The selected policy preserves those artifacts while allowing new backups whenever physical headroom permits. The owner-authored spec files are unchanged; this disagreement needs incorporation into the authoritative design.

## DbOps contract and layer scope

`restoreInto` returns the original SQLite `FileStore` after replacing the file and syncing its parent directory. Its real restore fixture checks the returned object and restored rows. SQLite keeps the same authoritative pathname; inventing a second selection journal would add no state transition. Remote selection journals belong to the runtime layer, where restore creates a different database.

The implemented service deliberately does not reproduce every method name in the proposed interface. Existing owners provide the behavior without adding convenience wrappers to boot:

| Proposed member | SQLite implementation on this layer |
| --- | --- |
| `cloneForRehearsal` | `DbOps.clone` copies, `prepareClone` sets the epoch, and cutover owns the proposal and child lifetime. |
| `backup` | The same bounded copy primitive; `DatabaseBackup.capture` writes and returns the complete engine-tagged catalog record. |
| `dropClone`, `reapClones` | The rehearsal file belongs to its scoped materialized proposal. Cutover requires child retirement before progressing, but proposal scope cleanup itself is not conditional on closure. Copy recovery separately owns interrupted copy artifacts. A general clone reaper and unconditional failed-clone retention are not implemented here. |
| `capacity` | `DbOps.estimatedBytes` estimates the store; `storageHeadroom` and `readStorageVolume` enforce volume capacity. |
| `tableExists` | Identity adoption performs the specific protected-table and shape probes it needs. There is no otherwise-unused generic probe service. |
| `readOnlySession` | The server SQL read worker opens an actual read-only SQLite client. It owns its deadline and process closure, rather than depending on a boot convenience method. |

These are explicit architecture differences from the sample DbOps interface, not claims that the exact proposed API exists. Remote clone provisioning, selection, disposal and recovery belong to #9; portable SQL belongs to #8; offline transfer belongs to #10. Those layers must establish their own behavior and acceptance.

The copy follow-up moves SQLite VACUUM INTO into an immutable worker with a responsive keeper. REHEARSAL_COPY_BUDGET defaults to 30 seconds; the keeper enforces it independently of the boot event loop. Timeout and parent EOF require positive worker exit and process-group absence before a bound, synced receipt permits cleanup. Missing keeper proof retains the copy journal and prevents its recovery path from deleting the destination; migration, restore and traffic resumption refuse. Independently scoped proposal cleanup is an exception: it can remove the proposal destination, so this is not a guarantee that every failed rehearsal file is retained. Normal completed copies still belong to their caller; this does not implement a general orphan-artifact reaper.

Boot schema 19 is a protocol-compatibility stamp, with no new SQL table. The sqlite_copy setting records a possible open database owner; an old image that ignores it must refuse the store. Pending recovery refuses upgrades below the supported target before changing schema or journal mode. The later Migrator ladder must include a named version 19 compatibility operation rather than merely mirror the number.

The hourly aggregate ten-second and pre-flip aggregate thirty-second capture timers are removed; existing drain and child-health budgets remain separate. Copy timeout is a typed rehearsal_copy_timeout with a store-size/budget hint. The implementation ownership is described above; the sample interface names are not promised.

The SQLite-only descendant helper, its package export and its dedicated fixtures are removed from this rung. Both consumers use the identical existing SQLite expressions consistently. The dialect-aware helper and literal/non-ASCII portability coverage belong to #8 and must be retained when composing that later layer.

Validation: six focused copy lifecycle tests pass, including committed WAL data, timeout, boot SIGKILL, missing keeper proof, Effect interruption and an emulated older schema ceiling. Twenty-three identity and backup metadata tests pass, including pending v18 recovery refusal. Tests ran with Node 22.22.3 and one Vitest worker; subprocess fixtures use Bun. Full check and build pass. The older-ceiling test emulates version 18 support; it does not launch a released older image. Full combined-stack acceptance remains an integration check.

Current focused acceptance: `db10dcf` passes nine backup/copy cases in 17.87 seconds; `5eb46d6` passes eleven public-path/topic cases in 23.09 seconds. Both use actual Node 22.22.3 and one Vitest worker; their subprocess fixtures use Bun. Full check and independent reviews pass. These focused runs do not replace new-head Linux/image/QEMU acceptance. Earlier validation above remains historical evidence.

## Verification follow-up: caller deadline and reboot support

The app backup request previously expired at 20 seconds despite the keeper allowing a 30-second copy. Boot now forwards its configured `REHEARSAL_COPY_BUDGET` into the child; the app request allows that budget plus 30 seconds for drain, closure and response framing. This is a finite caller allowance, not a guarantee on total operation-gate waiting and not evidence that a timed-out database owner has closed. Existing drain, health and keeper limits remain independent. Retained old app generations keep their historical caller behavior until their source is updated.

Unattended recovery after power loss requires the supported Linux deployment with a readable `/proc/sys/kernel/random/boot_id`, including when the interrupted attempt was first recorded. On platforms without that kernel identity, valid keeper receipts still permit process-restart recovery. If both the receipt and kernel-lifetime evidence are unavailable, recovery deliberately refuses; a new PID, elapsed time or an operator assertion cannot establish closure. Automatic power-loss recovery is not supported in that configuration. Use the Linux image for this guarantee; do not delete recovery journals or fabricate receipts. This is an explicit platform limitation, not a new fallback or a claim that unsupported recovery has been implemented.

Caller-budget verification passes six tests across two files with actual Node 22.22.3 and one worker in 21.86 seconds. The real immutable copy/keeper takes 21 seconds and returns through BootChannel with an injected HTTP transport; copied acknowledged rows and cleared copy intent are checked. TestClock also checks configured 30-second and 90-second budgets. This is not socket-level or supervisor-launch acceptance. Check and fresh review pass.
