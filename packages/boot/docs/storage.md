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

Maintenance runs every minute after boot schema initialization, independently of app liveness, including a legacy-topic-move refusal on the current schema. Pre-cut legacy stores are refused before schema changes so the previous compatible image can still open them. A pass deletes at most 2,048 **published** events in bounded transactions. It evicts `http.request` rows first, oldest first, before removing lifecycle history in sequence order. It never removes unpublished events or durable event-batch receipts. Each of nine bounded iterations also attempts a passive checkpoint, incremental reclamation of at most 256 free pages and WAL truncation with SQLite busy waiting disabled for that operation.

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

Event pruning does not remove durable batch receipts or keyed source-revert outcomes. These records prevent an old retry from undoing newer source a second time. Boot does not expire them by age. Historical selection-only keys are also preserved; an unknown outcome is refused rather than replayed as a new operation.

Source history determines which versions can be selected for a new revert. A receipt records an earlier request's result; it does not authorize repeating that operation or changing the current database.

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

## SQLite board identity and upgrades

Boot reserves one board UUID before writing the app store and finalizes it only after the app transaction is durable. Restart resumes that UUID. A missing initialized store or foreign identity refuses startup; it never creates an empty replacement board.

Backups catalogued before successful legacy adoption receive provenance once, without overwriting an existing stamp. Restoration adds missing identity only to an authorized disposable copy, preserving the original backup. Later identity-free backups are refused.

Finish any interrupted cutover or database restore with the previous compatible image before upgrading an installation that has never adopted an identity. A first upgrade cannot authorize an old identity-free backup before adoption completes, even if a recovery journal selects it. Boot preserves the journal, backup and current store for recovery; do not delete identity markers to bypass this refusal.

Restore uses one disposable `<app-store>.restore-staging` directory. After proving prior owners closed, startup removes an abandoned copy; each restore also replaces it before copying. A killed restore therefore cannot accumulate a new full-board directory on every attempt. Catalogued backup bytes are never modified by this cleanup.

After adoption is ready, moving the data directory or switching to the isolated store layout keeps the UUID authoritative. The original adoption filename is diagnostic history; only a pending adoption remains bound to its original path. Authenticated `/_boot/status` reports the expected UUID, adoption phase, selected filename and recorded filename. A foreign UUID returns `app_store_mismatch`; a missing initialized store remains `app_store_missing`. Authorized status includes `child.identity_error` with the expected and observed UUID after a mismatch; malformed identifiers become `null`. It does not open the refused store again to render diagnostics.

Human-only `GET /_boot/db/backups` reports the expected board UUID and each catalog row’s `provenance`: `legacy_adoption` identifies an existing legacy adoption association; `not_recorded` means no catalog identity stamp exists. This does not inspect artifact contents or prove that a backup belongs to the board.

Identity proves which board a copy belongs to, not how recent that copy is. A stale copy carrying the same UUID may pass identity verification. Use the explicit backup/restore procedure rather than swapping a matching-UUID file into place. Boot refuses app publication evidence ahead of its sequence allocator, but that check does not establish freshness of a stale same-board copy.

A signed-in human can restore a matching-board backup while the selected app store is missing or has a foreign identity. Boot requires completed identity adoption, positive closure of prior owners and no pending publication reservation. It verifies the target in disposable staging, then preserves the original file and SQLite sidecars byte for byte without opening them. Missing files are recorded as absent. The signed restore receipt reports `safety_backup: null` for this path; these opaque before-images are not valid board backups.

Before-images live under protected `restore-before/` directories, with hashes and selection metadata committed alongside the restore journal. A failed candidate restores the original bytes or absence and keeps the app unavailable; it never authorizes the foreign store to run. Restart replays an interrupted selection or rollback. Recorded before-images remain retained; startup reclaims only validated artifacts that were never recorded, after owner closure. Expand storage if these retained copies consume capacity. Do not bypass identity checks or discard a pending reservation to enable restore.

The startup cleanup also removes the former fixed `.restore` staging file and its SQLite sidecars after positive owner closure. A preidentity upgrade blocked by an unfinished journal returns `boot_identity_upgrade_pending` with HTTP 409, while keeping schema and journal evidence compatible with the previous image.

New backup filenames use `.db` for SQLite, `.dump` for PostgreSQL and `.sql` for MySQL. Previously catalogued remote `.db` artifacts remain restorable and eligible for pruning under the same engine, provenance and canonical-path checks; startup never renames them or infers their engine from a suffix. Remote identity diagnostics report selected and recorded database names, while the durable selected database remains authoritative after restore.

Opaque offline repair is available for SQLite in the standard `DATA_DIR/comms.db` and `DATA_DIR/store/comms.db` layouts. Custom SQLite paths retain ordinary verified-backup restore; PostgreSQL and MySQL retain their native restore and database-selection protocol.

## Power-loss recovery platform

Automatic recovery of interrupted database ownership after machine power loss requires Linux with readable `/proc/sys/kernel/random/boot_id` at both recording and recovery. Other local platforms support normal keeper-receipted process restarts. Without a receipt or verifiable kernel change, startup refuses to reopen the store. Use the Linux image when unattended power-loss recovery is required; never clear the ownership journal or invent a closed receipt to bypass this refusal.
