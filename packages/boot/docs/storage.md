# Manage storage

Boot checks disk capacity before admitting ordinary growth and prunes eligible events and backups. It preserves the records and artifacts needed for authentication, publication and recovery. This is an admission safeguard, not an operating-system quota: concurrent writes and arbitrary extension/build output can still fill a volume.

This guide describes the current SQLite implementation. Start with authenticated `GET /_boot/status` when a write reports a capacity error. See [deployment](../../../docs/deployment.md) for the data layout and [editing and recovery](../../server/pages/docs/editing.md) before changing source or restoring a database.

## Budgets and settings

| Setting            | Default | What it controls                                                                     |
| ------------------ | ------- | ------------------------------------------------------------------------------------ |
| `headroom_percent` | 5%      | Caller-available free space that ordinary growth must leave. Cannot be set below 5%. |
| `event_percent`    | 10%     | Physically accounted event storage, including shared free/WAL overhead.              |
| `backup_percent`   | 20%     | Catalogued app-store backup bytes plus a planned new copy.                           |

A signed-in human can read current settings through `GET /_boot/settings`. A human changes them with a fresh passkey assertion; use the Account UI or the schemas in `/.well-known/agent.json`. Each percentage must be greater than zero and less than 100, and their sum must be below 100. Settings use a revision to detect concurrent changes.

There is **no calendar-based event deletion** and no event-retention-days setting. Old settings rows are ignored; retained signed receipts can still replay their historical result without applying that retired setting.

## Respond to a capacity refusal

| Response                            | Meaning                                                                        | Next step                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Retriable `503`                     | Capacity information is missing, failed or stale, or stored policy is invalid. | Inspect the hint and status; restore valid measurement or configuration before retrying.                               |
| Non-retriable `507`                 | Measured free space or the configured budget is insufficient.                  | Expand storage or reclaim independently verified disposable artifacts; repeating the same write will not create space. |
| `reclaim_unavailable` in accounting | The store cannot incrementally reclaim its free pages.                         | Consider the offline conversion below after creating enough temporary space.                                           |

Do not delete `boot.db`, its WAL, recovery journals, source history or catalogued backups directly to clear an error. A retained backup or snapshot may still be needed by an interrupted operation. Do not treat a timeout or successful SQL DELETE as evidence that physical disk space was released.

At low space, boot keeps authentication, diagnostic reads, completed receipt replay, already-reserved publication/abort and recovery paths available. Page deletion and app deletion staging remain possible; deploying staged app deletions still requires the normal rehearsal and snapshot copies. These paths still require their usual authorization and recovery checks, and cannot guarantee success on an already exhausted filesystem.

## How growth admission works

New event reservations, non-deletion source changes, source/dependency copies and new database copies check headroom. Known copies must fit above the floor; source publication includes before/after journal and history images. Install/build admission checks current headroom but cannot predict arbitrary generated output.

Event reservations use a boot-scoped sample refreshed once per second. Missing, failed or more-than-five-second-old samples refuse ordinary growth. Known filesystem copies perform fresh checks. Ordinary reservation transactions do not launch disk-probe subprocesses.

Retries of completed app receipts do not create a new reservation. Starting health checks and the narrow accepted-generation public-page grant reconstruction have recovery exemptions before routing. Zero-event app metadata writes and direct extension SQL do not allocate sequences, so they are outside this reservation check. The guard is not a cap on all app writes.

## What event maintenance removes

The event charge includes active event-table/index B-tree pages, shared freelist pages, any retained main-file tail beyond logical size, and the physical WAL. Shared overhead cannot reliably be assigned to one table, so it is charged in full. Live non-event database pages are reported separately. This is not a whole-boot-store cap; protected identity and recovery state may exceed the event budget.

Maintenance runs every minute, independently of app liveness. A pass deletes at most 2,048 oldest **published** events in bounded transactions. It never removes unpublished events or durable event-batch receipts. Each of nine bounded iterations also attempts a passive checkpoint, incremental reclamation of at most 256 free pages and WAL truncation with SQLite busy waiting disabled for that operation.

Those limits bound iterations and incremental vacuum work, not checkpoint latency. A busy reader may keep WAL pressure high. The next physical measurement, rather than deletion/checkpoint success alone, determines whether reservations can resume.

Admission re-reads policy. Raising a budget can admit writes once measured usage fits; lowering it below current usage refuses growth until maintenance reclaims enough eligible storage. Accounting refresh inside admission only measures; it does not prune or checkpoint inside a reservation transaction.

## What backup and snapshot pruning preserves

Before reload or a database copy, boot prunes catalogued artifacts under the supervisor's operation gate. Oldest eligible hourly backups go first, then unreferenced manual backups, then old unprotected pre-flip/pre-restore backups.

The following stay protected:

- The five newest good generations and current/starting owners whose keeper attempts are not closed.
- Generations and backups referenced by unfinished cutover or restore operations.
- The operation's prior/current generation until completion, even after its process has retired.
- Artifacts with unknown legacy provenance or noncanonical locations.

Historical status labels alone do not retain artifacts forever. Manual/hourly backups are not pinned merely because their source generation is live. A terminal restore receipt preserves replay evidence but does not pin an otherwise unreferenced backup file.

Deletion uses canonical boot-owned paths, rejects symlink ancestors, syncs the parent directory and only then clears catalogue links. Interrupted deletion is reconciled on retry. Generation rows, failure history, keeper closure evidence, source journals/history and batch reconciliation evidence remain.

Prepared dependency/UI caches and uncatalogued files are not automatically pruned: boot lacks a durable reference catalogue for them. Expand storage or remove only artifacts whose disposability you have independently established.

## Receipt retention is separate from event retention

Event pruning does not remove durable batch receipts. Keyed source-revert terminal outcomes have a separate retention policy: they remain for at least 30 days, then an hourly bounded scan may remove them. Pending outcomes and unresolved journal bindings remain; unfinished cutover/publication prevents this pruning. Historical terminal receipts without a trustworthy timestamp receive a new full window when observed. Historical selection-only keys are preserved rather than replayed as new undo operations.

Do not promise indefinite source-revert replay after the retention window, and do not infer success or rollback from an old receipt's age.

## Convert a legacy SQLite store for reclamation

Fresh stores enable incremental auto-vacuum before creating tables. Older stores without it cannot reclaim shared free pages incrementally; ordinary reservations remain refused if physical pressure exceeds the event budget.

Conversion requires an explicit offline database rewrite:

1. Stop boot and all supervised children.
2. Retain a verified restorable copy of boot state.
3. Ensure sufficient temporary space for a full rewrite **plus** reserved headroom; expand the volume first if necessary.
4. Against the closed boot database, use the deployment's SQLite tooling to run:

   ```sql
   PRAGMA auto_vacuum=INCREMENTAL;
   VACUUM;
   ```

5. Verify database integrity and the resulting auto-vacuum mode before restarting.

Never run this rewrite automatically on a nearly full volume. There is no automated low-space conversion path.
