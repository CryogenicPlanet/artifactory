# Adversarial review B of `docs/database.md`: durability, concurrency, operations

Reviewed at repository head `6c21a88` ("Set Linux fixture budgets from measured startup costs"). `docs/database.md` is uncommitted and moving: findings 1 to 22 are against md5 `74b219a888cf371f97f7246188fe3efb` (1201 lines) and findings 23 to 29 against md5 `ff455c7e812034c17996bc11699af9c4` (1203 lines), after the all-three-engines requirement landed. The diff between the two is cosmetic in every section a finding cites. Section numbers throughout are the current layout: §14 at line 1012, §15 at 1099, §16 open questions at 1163, §17 corrections at 1178. Every quote is verbatim.

Lens: does the design keep the spec's guarantees on every engine, and can it be deployed, swapped and recovered. API naming and SQL syntax are reviewer A's.

Counts: 5 loses-a-write, 8 wedges-recovery, 6 weakens-a-stated-guarantee, 6 operational-gap, 4 imprecise. 29 findings.

---

## 1. The `seq` allocator is a read-modify-write that only SQLite's file lock makes atomic

**Severity: loses-a-write.**

**Doc.** §9.3: "`packages/boot/src/events.ts:153-187` reserves a range in one boot transaction against the `seq` singleton and an `event_batches` receipt, and `:118` publishes by setting `published_through=next-1`. **Every statement is portable. The only engine coupling is contention**." §9.1 mandates the opposite of what would save it: "**Write transactions must stay at READ COMMITTED.**"

**Why it is wrong.** Both allocator paths read the singleton and then write a value computed in JavaScript from that read:

- `reserve` (`events.ts:158-185`): `const current = yield* state` → `if (current.pending_id !== null) …` → `INSERT INTO event_batches VALUES(…,${current.next},${to},'pending')` → `UPDATE seq SET next=${to + 1}, pending_id=…`.
- `writeBoot` (`events.ts:192-195`): `const current = yield* state` → `INSERT INTO events(seq,…) VALUES(${current.next},…)`.

On SQLite, `sql.withTransaction` issues `BEGIN IMMEDIATE`, so the whole database is exclusively locked from the first statement and the read-modify-write is serial by construction. On Postgres at READ COMMITTED — which §9.1 requires — a plain `SELECT` takes no lock and both transactions read the same `next`. On MySQL InnoDB at the default REPEATABLE READ, the plain `SELECT` reads a consistent snapshot, which is the same hazard with a different cause.

**Concrete scenario (Postgres).** A proxied request finishes and the request-event consumer fiber (`request-events.ts:14-21`) calls `writeBoot`; concurrently the app child's mutation calls `POST /_boot/seq/reserve`, which enters `reserve`. Both read `seq.next = 100`. `reserve` inserts `event_batches(from_seq=100,to_seq=100)` and sets `next=101`. `writeBoot` inserts `events(seq=100)` and sets `next=next+1`. One of the two inserts violates `events.seq INTEGER PRIMARY KEY` (`events.ts:48`) — if `writeBoot` loses, the `http.request` diagnostic is dropped by its own catch; if the app's later `append` loses, `POST /_boot/events/append` fails after the app transaction has already committed, so a committed message's events can never be published and its `seq` sits above `published_through` forever. Interleave the two `pending_id IS NULL` checks instead and both reservations are admitted: the second `UPDATE seq` overwrites `pending_id`, the first batch's `append` then fails `reservation_mismatch` (`events.ts:103`), and recovery at `app-recovery.ts:110-114` looks for the *other* transaction's evidence and aborts or ignores a batch that is committed in the app store. That is an acknowledged write whose events are lost, which is the one invariant `SPEC.md` §7.1 numbers eighth and §6.3 spends a page on.

**Change.** Add a subsection to §9.3 stating that the allocator's atomicity comes from SQLite's `BEGIN IMMEDIATE` and must be re-established explicitly elsewhere. Specify the prelude for `reserve`, `append`, `abort` and `writeBoot`: `SELECT … FROM seq WHERE singleton=1 FOR UPDATE` on Postgres and MySQL as the first statement, before any value is read into JavaScript, or an equivalent single-statement `UPDATE seq SET next=next+? … RETURNING` form. Delete "Every statement is portable. The only engine coupling is contention" and replace it with the rule that every boot transaction that computes a value from a prior read of `seq` must take the row exclusively first. Add a container test to §12.3: two concurrent boot transactions, one `reserve` and one `writeBoot`, must produce two distinct sequence values and exactly one outstanding reservation.

---

## 2. The restored store's identity is durable state, and nothing in the design journals it

**Severity: loses-a-write.**

**Doc.** §10.3: "`restoreInto` restores into a *fresh* database and returns a new descriptor for the supervisor to hand down (`packages/boot/src/database-restore.ts:119` becomes `const store = yield* dbOps.restoreInto(target)`, and `:125`'s `launch` receives it)." §13 step 2 acceptance: "`restoreInto` returns the same descriptor it was given on SQLite, and the supervisor threads it through without noticing."

**Why it is wrong.** On SQLite the live store's identity is a constant: `AppRecovery.filename` is fixed when the layer is built (`app-recovery.ts:19`, `:25`), and `restore` replaces the bytes behind that constant (`app-backup.ts:49-59`). On Postgres and MySQL the restore changes *which database is the board*, and that fact has exactly three homes in the current code, all of them non-durable or wrong:

- `supervisor.start` launches with `recovery.filename` (`supervisor.ts:172`), read from the service, not from the restore's result.
- `cutover.ts`'s rollback path calls `backup.restore(saved)` (`cutover.ts:71`) and discards any return value; the subsequent `start(prior.generation)` (`cutover.ts:297`) and `recovery.prepare` (`cutover.ts:72`) both use the old descriptor.
- Boot start reads the descriptor from the environment. Nothing persists it.

**Concrete scenario (Postgres).** A human restores a backup. `restoreInto` creates `comms_app_2`, the candidate launches against it, health passes, `db.restored` is written, traffic flips. The board serves from `comms_app_2` for six hours and takes 400 messages. The container restarts (deploy, OOM, host reboot). Boot reads `DATABASE_URL`, which still names `comms_app`, and comes up on the pre-restore database. Every one of those 400 acknowledged messages is gone, their events remain in the boot log above `published_through`, and `seq` in the boot store is 400 ahead of anything in the store now serving. No error is raised anywhere: the fence is installed fresh, the shape probes pass, the board simply has six hours missing.

A second scenario needs no restart. A cutover fails health at `SPEC.md` §7.7 step 8. `cutover.ts:294` calls `restore(persisted)`, which on a remote engine restores into `comms_app_3` and throws the descriptor away; `cutover.ts:297` then starts a child against `comms_app`, the store the failed candidate's migrations already mutated. The half-migrated store becomes live and the correctly restored one is orphaned.

**Change.** §10.3 and §5.2 must state that on a remote engine the live app-store descriptor is durable boot state, not configuration. Specify: a `settings` row (or a column on the cutover/restore journal) holds the current app-store descriptor; `restoreInto` writes it in the same boot transaction that records the restore phase; `AppRecovery.store` becomes a `Ref` seeded from that row at start and updated with it; boot start prefers the journaled descriptor over `DATABASE_URL` and refuses to start with a diagnostic when the two disagree on anything but the database name. Add the cutover rollback path (`cutover.ts:58-74`, `:294-297`) to §10.3's list of call sites — the doc currently names only `database-restore.ts`. Add to §13 step 2's acceptance: a restore followed by a boot restart serves the restored store, proved by a test.

---

## 3. Boot reaches the app store with the app's credential, so it cannot own the shared tables and cannot read them to back them up

**Severity: wedges-recovery.**

**Doc.** §3.2: "Boot creates and owns exactly four tables in the app database … Boot owning these tables is stronger than the SQLite arrangement, not weaker: on Postgres only the owner can `DROP` or `ALTER` them, so an app-side migration cannot remove the tables boot recovers from." §4.4 maps boot's own app-store connections — `app-recovery.ts:104` and `app-backup.ts:26`, `:47` — to "`Store.clientLayer(appStore)`", where `appStore` is the descriptor parsed from `DATABASE_URL`.

**Why it is wrong.** There is one app-store descriptor in the design, and §4.1's grammar embeds the credential in it (`postgres://app:secret@db:5432/comms_app`). That descriptor is what §3.2 renders into the child environment. So "boot connects to the app store" means "boot connects as `comms_app`". Three things follow:

- Tables boot creates at `app-recovery.ts:39-42` are owned by `comms_app`, not `comms_boot`. The ownership protection §3.2 claims, and which §14.4 item 4 uses as the baseline MySQL is measured against, does not exist on Postgres either.
- The `GRANT SELECT, INSERT, UPDATE, DELETE ON kernel_writer, mutation_batches, outbox TO comms_app` in §3.2 is issued by `comms_app` on tables it already owns: a no-op that reads as a boundary.
- `pg_dump` run with the `comms_boot` credential has `USAGE, CREATE ON SCHEMA public` and no privilege on any app-owned table, so it fails on the first `SELECT`. Run with the `comms_app` credential it works, and then `DbOps.backup` holds the same credential the child holds, which is the credential R3 exists to keep separated.

The restore direction has the mirror problem. §5.2 specifies `pg_dump -Fc --no-owner --no-privileges` for `backup` and `pg_restore` into a fresh database for `restoreInto`. `--no-owner` makes every restored object owned by the restoring role. If boot restores as `comms_boot`, the app role owns nothing and has no grants in the restored database, so the first child to open it fails on `SELECT … FROM topics`. If boot restores as `comms_app`, the shared recovery tables come back owned by the app. The same applies to `cloneForRehearsal`: a clone created `OWNER comms_boot` and loaded `--no-owner` is a database the app-credentialed rehearsal child cannot write, so *every rehearsal fails*, and by §7.7 step 2 every edit fails with it — the agent is told its edit is broken when the edit is fine, which is exactly the confusion §5.3 was written to prevent.

**Change.** §3.2 must decide which role boot uses against the app database and say so in one sentence, then make the script and §4.4's table agree. The workable shape: a third descriptor, `BOOT_APP_DATABASE_URL` (`comms_boot`'s credential, `comms_app`'s database name), used by `DbOps` and `AppRecovery` and never rendered into the child map; `DATABASE_URL` stays the app's and is the only one the child sees. Then the grant script needs `ALTER DEFAULT PRIVILEGES FOR ROLE comms_app IN SCHEMA public GRANT SELECT ON TABLES TO comms_boot` plus an equivalent for tables that already exist, so `pg_dump` can read an agent-added table; state explicitly that an agent who revokes that grant breaks backups, and that this is the accepted cost of an editable schema. Specify `pg_restore --no-owner --role=comms_app` (or a `SET ROLE` wrapper) so restored and cloned objects land under the role the child uses, and say which role owns the four shared tables after a restore. If the owner prefers two credentials over three, §3.2's ownership-protection paragraph and §14.4 item 4's Postgres baseline both have to be deleted, not weakened.

---

## 4. The checked-in Postgres grant script forbids the privilege every `DbOps` operation needs

**Severity: wedges-recovery.**

**Doc.** §3.2's script: "`CREATE ROLE comms_boot LOGIN PASSWORD :'boot_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`" and the note "`NOSUPERUSER NOCREATEDB` is the load-bearing half of the whole boundary." §5.2 then requires boot to run "`CREATE DATABASE comms_rehearsal_<label> OWNER comms_boot`" and "`CREATE DATABASE comms_app_<n> OWNER comms_app`".

**Why it is wrong.** `CREATE DATABASE` requires `CREATEDB` or superuser, and naming an `OWNER` other than yourself requires membership in that role. `comms_boot` has neither. Every remote rehearsal, every drill and every restore fails at its first statement, on a fresh install, with the script the doc ships. The MySQL script in §3.3 got this right — it grants `comms_boot` the wildcard privileges on `comms_rehearsal\_%`, `comms_drill\_%` and `comms_app\_%` — so the omission is Postgres-only and looks like drift between the two scripts.

**Concrete scenario.** An operator follows §3.2 exactly, sets both URLs, starts the container. Boot comes up. The first `PUT /_boot/fs/app/ext/core.ts` reaches §7.7 step 2, `cloneForRehearsal` issues `CREATE DATABASE`, Postgres answers `permission denied to create database`, and the edit returns a `DbOpsError`. Every edit returns it. `POST /_boot/db/restore` fails the same way. The deployment can serve but can never be changed or recovered, which inverts `SPEC.md` §7.1's whole premise that the edit loop is the thing that always works.

**Change.** In §3.2's script, give `comms_boot` `CREATEDB`, and either `GRANT comms_app TO comms_boot` (so `OWNER comms_app` is legal) or drop the `OWNER` clause and set ownership after restore. Rewrite the "must not have `CREATEDB`" note so it constrains the *app* role only: the sentence currently reads as a rule about both. Add a line to §3.2 stating that new databases inherit `CONNECT` for `PUBLIC` from `template1`, so `cloneForRehearsal` and `restoreInto` must `REVOKE CONNECT … FROM PUBLIC` at creation time and not only at drop time (§5.2 currently revokes in `dropClone`, which is too late to stop an app-credentialed child from connecting to a rehearsal clone or a restore target).

---

## 5. The read prelude puts a row lock around an HTTP call to boot

**Severity: wedges-recovery.**

**Doc.** §9.2's prelude table: "pg — `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, then `SELECT epoch FROM kernel_writer FOR SHARE`". §9.4 considers only the write path: "`boot.reserve` is called from inside `sql.withTransaction` during a mutation."

**Why it is wrong.** The read path makes a boot call inside the transaction too. `messages.ts:244-248` is `sql.withTransaction(… SELECT epoch FROM kernel_writer; const ceiling = (yield* fence).published_through …)`, and `fence` is `request("/_boot/seq", …)` (`boot-channel.ts:114`) with a 1500 ms timeout (`:106`). The same shape is at `messages.ts:294`, `topics.ts:49`, `topics.ts:127`, `extension-data.ts:63` and `pages.ts:38` — the six sites §9.2 itself lists. Today that transaction takes no lock on Postgres, which is precisely why §9.2 adds `FOR SHARE`. With the prelude, every list read holds a shared row lock on `kernel_writer` across an HTTP round trip to boot, and boot answers it with a query against its own database on the same remote server.

**Concrete scenario (Postgres, managed, 20-connection limit).** Ten agents long-poll `/api/messages`. Each opens a read transaction, takes `FOR SHARE`, and blocks on `GET /_boot/seq`. Boot needs a connection to `comms_boot` to answer; the app's read connections plus the child's pool have taken them. Boot's query queues, the app's 1500 ms timeout fires, every read returns `boot_unavailable`, the locks release, the agents retry, and the pattern repeats. Meanwhile any mutation's `UPDATE kernel_writer` is queued behind the shared locks, so writes stall behind reads that are stalled behind boot. On SQLite the same code cannot deadlock this way: boot's store is a different file with a different lock and there is no shared connection budget.

**Change.** §9.2 must state that the `FOR SHARE` prelude is only shippable once `pr-comments.md` item 10 ("Cache the publication fence") has removed the boot round trip from inside the read transaction, and make that an explicit dependency in §13 step 5 rather than leaving it to the base work. Until then, the fence must be read *before* `withTransaction` opens, and §9.2 must say whether reading it earlier is compatible with its own correctness argument (it is: a fence read before the lock is taken is at most stale, which is the safe direction). Add to §9.4 the sentence that no boot HTTP call may be made while any `kernel_writer` lock is held, on either the read or the write path, and name the six read sites as the places to check.

---

## 6. Two databases live on one remote server, so §10.6's budget table defends a volume that holds neither store

**Severity: weakens-a-stated-guarantee.**

**Doc.** §10.6's table: "Events under a 10% cap — **Unchanged.** `packages/boot/src/event-retention.ts` prunes rows by policy, not by bytes"; "5% headroom refusal — **Applies to the volume only.** That is where boot's own writes land (snapshots, dumps, staging blobs in the boot store **when it is SQLite**, caches)".

**Why it is wrong.** R1 and R2 move *both* stores. The table is written as though only the app store went remote. With the boot store on Postgres, `versions.content`, `versions.previous_content`, `staging.content` and `source_changes` blobs (up to 1 MiB each, `SPEC.md` §7.5) and the entire `events` table live on the remote server, whose capacity R9 says is unknown. `SPEC.md` §7.5's event cap is "the retention in §6.1 plus a 10% cap" — a byte cap against the volume — and there is no volume under those rows any more. So three of the four budgets measure and defend a disk that holds only snapshots and dump artefacts.

**Concrete scenario.** An agent loops an edit that rewrites a 900 KiB file 2,000 times. Each write records a before-image and an after-image in `versions`. On SQLite the 5% headroom refusal stops it and `/_boot/status` shows the budget filling. On Postgres nothing counts those bytes, `capacity` reports `total: None`, and the first symptom is the provider's disk-full error surfacing as a `SqlError` on the next `/_boot/fs` write — which is `SPEC.md` §7.1 invariant 1 failing, with no warning before it.

**Change.** Retitle §10.6's table "With both stores on a remote engine" and split each row into a volume part and a store part. State plainly that the event byte cap and the version/staging blob budget have no enforceable form when the boot store is remote, and pick one of: enforce them as row counts and summed `length()` against the store (cheap, engine-neutral, and gives `/_boot/status` a number it can justify), or record the loss in §14.2 alongside the capacity finding. §14.2 currently says "the property that matters most — a delete always has room to record itself — survives", which is only true while boot's own rows are on the volume.

---

## 7. The freeze budget on a remote engine is a sum of network round trips, and the doc declines to design for it

**Severity: weakens-a-stated-guarantee.**

**Doc.** §9.4: "The 10-second freeze budget in `SPEC.md` §7.7 step 4 now has to absorb both. **Measure it; do not redesign for it.** If it turns out not to fit, the answer is a larger freeze budget for remote deployments, expressed as configuration, not a different protocol."

**Why it is not enough.** The freeze budget is not a per-mutation budget; it bounds the drain of *every* admitted mutation (`cutover.ts:177-190`, one `Effect.timeoutOrElse` of 10 seconds around `traffic.drained`). Admitted mutations serialize on the writer fence, so the drain is their sum. One remote mutation costs: the epoch gate round trip, `boot.reserve` (up to 1500 ms, and boot's own transaction is now a remote round trip too), the domain writes, the batch and outbox inserts, the commit, and then `POST /_boot/events/append` (another 1500 ms ceiling) before the response is acknowledged. Four admitted mutations at 2.5 s each exceed the budget.

**Concrete scenario.** An agent holds the lock and calls `PUT /_boot/fs/app/ext/core.ts` while three other agents are mid-`POST /api/messages` against a database in another availability zone. Rehearsal passes, the freeze starts, the three in-flight mutations drain in 11 seconds, `FreezeTimeout` fires, queued writes are released and the edit returns `freeze_timeout` (`cutover.ts:315`). Nothing is lost — the design is correct here — but the agent cannot land an edit while the board is in use, and the retry hits the same wall. `SPEC.md` §7.1's premise is that an agent always recovers by editing again.

**Change.** Replace "Measure it; do not redesign for it" with a budget rule: the remote freeze budget is `max admitted mutation concurrency × worst-case mutation latency`, both of which the design already controls, and state the two knobs — a configured remote budget and a bound on concurrently admitted mutations. State the failure mode explicitly in §9.4, because it is currently only derivable from `cutover.ts`: exceeding the budget abandons the cutover before the backup, releases queued writes, loses nothing, and returns `freeze_timeout` to the editing agent. Add it to §16's measurement list as a pass/fail criterion rather than a number to record.

---

## 8. Nothing bounds how long a migration waits for a table lock, and §7.7 step 6 allows only five seconds

**Severity: wedges-recovery.**

**Doc.** §14.4 item 1's compensation rests on "R6: rehearsal runs the real migration against a real copy in a real candidate process before the live store is touched". `SPEC.md` §7.7 step 4 keeps reads flowing ("Reads keep flowing to the live child") and step 6 gives the candidate "5s deadline" from `go` to health, inside which it "runs its migrations and the self-test".

**Why it breaks on Postgres.** `ALTER TABLE` needs `ACCESS EXCLUSIVE`. The live child is frozen for writes but still serving reads, and each of its read transactions now holds `FOR SHARE` on `kernel_writer` and ordinary `ACCESS SHARE` on `messages` for its duration. A blocked `ACCESS EXCLUSIVE` request queues *ahead* of every subsequent lock request on that table, so one in-flight read does not merely delay the migration — it stalls every later read behind the migration's queued lock.

**Concrete scenario.** A long-poll read on `/api/messages` (up to 60 s by `SPEC.md` §6.3) is open when `go` is sent. The candidate's `ALTER TABLE messages ADD COLUMN` queues. Every read arriving after it queues too, so "reads keep flowing" becomes "reads hang". At five seconds the candidate is killed; `SPEC.md` §7.7 step 8 restores the pre-flip backup. The cutover is correctly abandoned and no write is lost, but the board's reads were frozen for the window, which step 4 explicitly promises not to do, and the edit fails for a reason no rehearsal can reproduce (the rehearsal clone has no concurrent readers).

**Change.** Add a subsection to §9 specifying session-level timeouts per engine: `lock_timeout` (short, sub-second) and `statement_timeout` on the candidate's migration session so a migration that cannot get its lock fails the cutover promptly instead of queueing behind readers; `statement_timeout` on the app's read sessions so a stuck read cannot hold a table lock for a minute; and the MySQL equivalents (`lock_wait_timeout`, `innodb_lock_wait_timeout`). State in §14.1 or §9 that `SPEC.md` §7.7 step 4's "reads keep flowing" is weakened on Postgres for the duration of a DDL migration, and that the compensation is the short `lock_timeout` plus the step-8 restore.

---

## 9. "The app store is missing" is a file-existence check with no remote equivalent

**Severity: loses-a-write.**

**Doc.** §13 step 1: "Rename `AppRecovery.filename` to `AppRecovery.store`. … **Acceptance.** Zero behaviour change." §6.10 names one `tableExists` site (`public-pages.ts:67`).

**Why it is wrong.** `SPEC.md` §6.3 says "The marker prevents silently recreating a missing app store", and the mechanism is two lines: `app-recovery.ts:28-30` reads `settings.app_store_initialized` from the boot store and `fs.exists(filename)` from the volume, and fails `app_store_missing` when the marker exists and the file does not. `cutover.ts:141` has a second `fs.exists(recovery.filename)`. A rename from `filename` to `store` deletes the meaning of both: there is no `fs.exists` for `postgres://…/comms_app`.

**Concrete scenario.** An operator recovers a box, or fat-fingers a database name, and points `DATABASE_URL` at an empty `comms_app2` while the boot store still carries the marker, the versions, the event log and `seq.next = 80421`. If the existence check is dropped, `marker.length === 0` is false so boot skips table creation, then `UPDATE kernel_writer … RETURNING epoch` affects zero rows and fails `app_fence_invalid` — a wedge, but at least loud. If an implementer instead makes the check `tableExists("kernel_writer")` and lets a false result take the initialization branch, boot creates the three tables in the empty database, the child's migrations build a fresh domain schema, and the board comes up empty and writable, handing out sequence numbers from 80421 that already name messages nobody can see any more. Neither outcome is what the spec line promises, and the doc chooses neither.

**Change.** §5.1 and §13 step 1 must name the remote form of "the store exists and is the one the marker refers to". The workable form: `DbOps.storeIdentity`, a boot-owned row in the app store carrying a store UUID minted at initialization and mirrored in the boot store's `settings`, checked on every `prepare`; a reachable store whose identity row is absent or different is `app_store_missing`, and an unreachable store is a distinct retriable failure that never takes the initialization branch. Add both `fs.exists` sites (`app-recovery.ts:29`, `cutover.ts:141`) to step 1's file list and delete "Zero behaviour change" from its acceptance, because this one is a behaviour change and it is the one that matters.

---

## 10. A backup taken on one engine is offered for restore on another

**Severity: wedges-recovery.**

**Doc.** §15.1 transfers the boot store including "`generations`, `backups`, `settings`". §10.2: "`path` becomes 'path to the restorable artefact on the volume', which is a database file on SQLite and a dump on Postgres and MySQL." Cross-engine restore is claimed nowhere and refused nowhere.

**Why it matters.** `backups` rows survive the transfer by design, and `GET /_boot/db/backups` lists them. After a SQLite-to-Postgres transfer, the list is full of `${id}.db` SQLite files that `DbOps.restoreInto` for Postgres cannot read, and the newest artefact — the one the drill picks in §10.4 step 1, and the one a human reaches for first — may be one of them.

**Concrete scenario.** A board moves to Postgres on Monday. On Tuesday an agent runs a destructive `POST /api/sql`. The human calls `GET /_boot/db/backups`, picks Monday morning's pre-flip backup, and calls `POST /_boot/db/restore`. `saved()` (`database-restore.ts:47-56`) validates the extension by dialect, so the SQLite artefact is now `restore_backup_invalid`, or — if the extension check is relaxed as §10.2 suggests, "`${id}.db`, `${id}.dump` or `${id}.sql` by dialect" — `pg_restore` is handed a SQLite file and fails partway, leaving a partial `comms_app_2` and the journal in `working`. Either way the human's one recovery route fails at the moment they need it, with the pre-flip backup from before the bad statement sitting on the volume and unusable.

**Change.** Add `engine` to the `backups` row in §10.2 (the schema change the section currently says is unnecessary), stamped at capture. `POST /_boot/db/restore` and the drill refuse an artefact whose engine differs from the deployment's, with a distinct code such as `backup_engine_mismatch` and a message pointing at the transfer tool. State in §15 what the transfer does with the `backups` catalogue: either it takes a fresh backup on the target and marks the transferred rows as historical-only, or it drops them. Say explicitly, in §10.2 and in §15.5, that cross-engine restore is not supported and that an engine change makes every prior artefact non-restorable — that is a real durability cliff and it currently appears nowhere.

---

## 11. Rehearsal and restore clones accumulate on the production server with no budget and no success-path cleanup

**Severity: operational-gap.**

**Doc.** §5.4: "`dropClone` is called explicitly, only after closure is proven, and `reapClones` is the backstop for what that leaves behind (section 10.5)." §10.5: "`DbOps.reapClones` runs once on boot start, lists scratch databases matching `comms_rehearsal_%` and `comms_drill_%`, and drops those not referenced by a live record."

**Why it is not enough.** On SQLite the rehearsal copy is a file inside the materialized proposal tree (`cutover.ts:142`), so it disappears with the tree at the end of every swap, which is what `SPEC.md` §7.5 promises ("The rehearsal copy is deleted at the end of every swap"). On a remote engine the clone is a database and nothing in §7.7's sequence drops it: §5.4 defers to "only after closure is proven" and §10.5's reaper runs at boot start. A box that boots once a month and takes thirty edits a day accumulates nine hundred full-size copies of the board on the same server as the live store, whose capacity R9 says is unknown and §10.6 says nothing budgets. Each clone also holds schema objects, and the dump-and-load path holds connections against a managed instance's connection cap while it runs.

`reapClones`'s pattern is also unsafe as written: `LIKE 'comms_rehearsal_%'` treats `_` as a single-character wildcard, so it matches names the design never created, and it omits `comms_app_%` — the restore targets, which are the copies that actually grow without bound (one per restore, forever, including the live one, which must never be dropped).

**Concrete scenario.** Rehearsal clone `comms_rehearsal_412` is created, the rehearsal child passes, `stop(rehearsed)` produces its receipt, the cutover proceeds and nobody drops the clone. Two hundred edits later the provider's storage alarm fires, `pg_dump` for the next pre-flip backup fails on a full disk, and the cutover cannot take its step-5 backup — so the edit fails and the board is stuck on the old generation with no way to make room from inside comms, because `DELETE /_boot/fs` frees volume bytes and the clones are not on the volume.

**Change.** §7.7's sequence (via §5.2 or a new §5.6) must call `dropClone` on the rehearsal clone as soon as the rehearsal child's closure receipt is recorded, on the success path as well as the failure path, and §5.4's "only after closure is proven" must be read as a precondition, not a deferral. Escape the underscores in §10.5's patterns. State the rule for restore targets: `comms_app_%` databases are never reaped automatically, the live one is identified by the journaled descriptor from finding 2, and superseded ones are listed by `/_boot/status` for a human to drop. Add a cap: refuse a new clone when more than N scratch databases exist, with a diagnostic naming them.

---

## 12. Every agent-authored migration is a portability risk the design cannot check, and R4b depends on all of them

**Severity: weakens-a-stated-guarantee.**

**Doc.** R4b: "A deployment can move from one engine to another without losing a `seq`, an event, a token or a message. Section 15 is the procedure." §15.3 step 4: "**Create the target schema by running migrations.** Not by copying DDL. The target gets its schema from the same migration ladder every fresh deployment runs, with the target dialect's branches."

**Why it is wrong.** The app's ladder is not shipped in the image. `SPEC.md` §7.4 makes `app/migrations/NNN-name.sql` agent-editable, and §7.6 of this doc asks agents to branch DDL with `onDialectOrElse` — a README paragraph, not an enforcement. A board that has been running for six months on SQLite has migrations written by agents that reached for `json_extract`, `INSERT OR REPLACE`, FTS5 virtual tables and two-argument `MAX`, because those worked. Step 4 replays that ladder against Postgres and fails on the first one, at the moment the operator has decided to move.

§12.3's cheap pglite test — "assert that every migration file compiles to valid DDL on all three dialects" — covers the migrations in the repository at build time, not the ones an agent writes into `/data/app/migrations` at runtime, which are the only ones that matter here.

**Concrete scenario.** The operator provisions Postgres, runs the grant script, stops the board, runs `store-transfer`. Steps 1 through 3 pass. Step 4 fails on `app/migrations/007-add-thread-index.sql` because it creates an FTS5 virtual table. The source is untouched, so nothing is lost — but R4b's promise, and `SPEC.md` §12's "everything works after the swap, including moving an existing board between engines", are false for any board whose agents were not disciplined, and nothing told them at edit time.

**Change.** §15.3 step 4 must state the precondition: a board is transferable only if every agent-authored migration has a branch for the target dialect. Then give it teeth at edit time rather than at transfer time — the rehearsal in §7.7 step 2 already runs every pending migration, so add a portability check there: compile each new migration under all three dialect compilers (no server needed, it is `Statement`'s compiler) and emit a `migration.non_portable` warning naming the dialect it would fail on, without failing the edit. Add the same sentence to §7.6's README paragraph. And say in §14.5 or §15.5 that R4b is conditional on this discipline, because it is currently stated as unconditional in R4b, in §1.1 and in `SPEC.md` §12.

---

## 13. The `.db` suffix is validated in more places than §10.2 accounts for

**Severity: wedges-recovery.**

**Doc.** §10.2: "**Two** validations in `packages/boot/src/database-restore.ts:47-56` hardcode `${id}.db` as the filename and check `realPath` against the backups directory. Both become extension-aware."

**Why it is incomplete.** `cutover.ts:65` does the same check on the rollback path: `if (!saved || saved !== path.join(options.dataDirectory, "backups", `${record.backup}.db`)) return yield* new ChildError({ code: "cutover_backup_invalid" })`. It is not in `database-restore.ts` and the doc does not name it. Both restore paths also derive the backups directory from the store: `path.join(path.dirname(recovery.filename), "backups")` (`database-restore.ts:46`, `:247`, `scheduled-backup.ts:62`), and `path.dirname("postgres://user@host/db")` is meaningless.

**Concrete scenario.** Steps 5 and 6 land, a candidate fails health on Postgres, `cutover.ts:294` calls `restore(persisted)`, the path comparison at `:65` rejects `backups/<id>.dump`, and the rollback fails with `cutover_backup_invalid` instead of restoring. The prior generation is closed, no replacement is started, and the board is down with a good backup on disk that boot refuses to look at.

**Change.** §10.2 should say "three validations", name `cutover.ts:65` alongside `database-restore.ts:47-56`, and add the rule that the backups directory comes from `DATA_DIR`, never from the store descriptor — with the three sites listed. Add "a cutover that fails health on a remote engine restores its pre-flip artefact" to §13 step 5's acceptance, which currently tests only the happy path ("A cutover, a restore and a drill all complete against a real Postgres").

---

## 14. MySQL's default isolation contradicts §9.1's rule for write transactions, and the doc never reconciles it

**Severity: weakens-a-stated-guarantee.**

**Doc.** §9.1: "**Write transactions must stay at READ COMMITTED.** … Under `REPEATABLE READ`, a concurrent `UPDATE` on the same row does not block and then return zero rows; it raises a serialization failure (`40001`)." §9.2's table: "mysql — `SELECT epoch FROM kernel_writer FOR SHARE` (**InnoDB already defaults to REPEATABLE READ**)."

**Why it matters.** Read the two together and MySQL write transactions run at REPEATABLE READ, which §9.1 forbids in the strongest terms it has. The rule is a Postgres rule: InnoDB's REPEATABLE READ does *not* raise `40001` on a blocking `UPDATE`; it performs a current read after the lock is granted, so the stale writer does get zero affected rows and the typed `stale_writer` survives. The design happens to be safe, and an implementer following §9.1 literally would set READ COMMITTED on MySQL write sessions — at which point §9.2's parenthetical, which is the only thing making its MySQL prelude a snapshot, is being contradicted from the other direction.

There is also an unstated dependency: §9.2's MySQL prelude assumes the *server's* `transaction_isolation` default, which an operator can and does change. A server set to `READ-COMMITTED` silently degrades the read snapshot with no error.

**Change.** §9.1 must say the rule is Postgres-specific and why: on InnoDB a conditional `UPDATE` under REPEATABLE READ blocks and then reads current, so zero affected rows is still the outcome and no serialization error is raised. §9.2's MySQL row must set the isolation level explicitly rather than relying on a server default, exactly as the Postgres row does, and §14.4 should add a startup assertion on `transaction_isolation` next to its existing collation assertion. Extend §12.3 test 1 to assert, on MySQL, that the stale writer sees zero affected rows and not a `1213`/`40001`.

---

## 15. Dump-and-load rehearsal catches less than `VACUUM INTO` in three specific ways, and §14.1 records none of them

**Severity: weakens-a-stated-guarantee.**

**Doc.** R6: "Rehearsal always runs a real candidate process with the full self-test against a real copy of the data. Never a rolled-back in-process migration, never an empty schema, never a sample." §14.1 lists only the time cost: "Rehearsal time becomes a function of data volume."

**Where it catches less.**

- **A logical reload normalises the store.** `VACUUM INTO` reproduces the physical store; `pg_dump | pg_restore` and `mysqldump | mysql` rebuild every index and re-apply every constraint. A row set that the live store holds but a fresh load would reject (a duplicate that predates a later unique index, a value that violates a `CHECK` added by an earlier migration) fails the *clone*, surfacing as `clone_failed` or `rehearsal_copy_timeout` rather than as the migration failure it is. §5.3's whole argument is that `rehearsal_copy_timeout` means "your store is too large", so an agent is sent to the wrong explanation.
- **The MySQL clone and the MySQL backup are produced by different commands.** §5.2 specifies `mysqldump --single-transaction` for `cloneForRehearsal` and `mysqldump --single-transaction --routines` for `backup`. Stored routines and events therefore exist in the artefact a restore produces and not in the clone a rehearsal runs against. A migration or an extension that depends on one passes rehearsal and fails live, or the reverse.
- **The clone is not isolated from production.** On SQLite the rehearsal copy is a file on the volume under an explicit byte budget. On a remote engine it is a database on the same server, sharing the disk, the connection cap and the buffer pool with the live store. A rehearsal of a migration that rewrites a large table can degrade or fill the live store — the rehearsal can take down the thing it was protecting.

**Change.** Add a subsection §14.1a, "What rehearsal stops catching on a remote engine", with those three items. Make the MySQL clone and backup use identical dump flags and say so in §5.2. Give `clone_failed` a distinct code for "the clone loaded but the data did not survive reload" so it is not read as a size problem. State in §14.1 that a remote rehearsal shares resources with production and that a clone must be refused when the scratch count or the store size makes that unsafe (this is the same budget as finding 11).

---

## 16. §10.3 builds a requirement on a defect that is already fixed at this head

**Severity: imprecise.**

**Doc.** §10.3: "`pr-comments.md` item 24 point 1 records that `packages/boot/src/database-restore.ts:89-92` releases the request gate as a last statement rather than in `Effect.ensuring`, so four reachable failure paths leave every request to the board answering 503 for the life of the boot process."

**Why it is stale.** At `6c21a88`, `database-restore.ts:89-92` is the definition of `release`, and it is attached at `:303` as `Effect.ensuring(release)` on the restore pipeline, with a second `Effect.tapCause` at `:296-302` unrouting before it. The gate is already released on the failure paths. The dependency the section draws from it ("this track must not land on top of an unfixed gate") is therefore asserted against a fix that has landed, which makes the sequencing claim unverifiable for a reader.

**Change.** Rewrite the paragraph as a property to preserve rather than a defect to wait for: `restoreInto` returning a new descriptor adds a failure path (`pg_restore` failing partway) between the freeze and the pointer switch, so every gate release must remain in `Effect.ensuring` and the new path must be covered by the restore failure-mode suite. Cite `database-restore.ts:303` as the current mechanism.

---

## 17. Credentials can reach an agent through the stderr tail and the failed-generation record

**Severity: operational-gap.**

**Doc.** §4.2: "Keep it in `Redacted` end to end; never `Redacted.value` it outside the layer factory and the child environment map." R3: "The app's credential reaches each child in its explicit per-attempt environment map."

**Why it is not enough.** `SPEC.md` §7.1 invariant 5 requires the failure response to carry "the stderr tail", and the code does: `supervisor.ts:78` redacts with `text.replace(/[a-f0-9]{64}/g, "[redacted]")`, which is shaped for the 64-hex boot secret and writer epoch. A connection string is not 64 hex characters. `cutover.ts:259` and `:269` apply the same regex to the cause and the stderr before storing them in `generations.error`/`generations.stderr` and returning them to the editing agent. A `PgClient.layer` that fails to connect produces a cause that can carry the configuration; a child that dies on a bad `DATABASE_URL` prints it.

**Concrete scenario.** An operator mistypes the app password. Every candidate fails to open the store. The editing agent gets a `failed` write response whose `stderr` contains `postgres://comms_app:hunter2@db:5432/comms_app`, and the same string is persisted in `generations.stderr` and readable by any `fs`-scoped agent through `GET /_boot/generations`, and by anyone the board's pages are shared with if an extension renders it.

**Change.** §4.2 gains a paragraph: redaction is not only a logging concern, because boot deliberately surfaces child stderr to agents. Specify that `supervisor.ts:78`'s redactor also rewrites anything matching `scheme://user:password@host` to `scheme://[redacted]@host`, that the child wraps `SqlError` from `Store.clientLayer` into a typed error carrying host and database name only, and that a test asserts a wrong-password start produces a failure body containing no password. Add it to §13 step 5's acceptance.

---

## 18. The `public_paths` projection has no shape probe, so a dropped projection passes health

**Severity: operational-gap.**

**Doc.** §3.2: "Boot creates it and grants the app write access, so the grant is in code the agent cannot edit." §14.4 item 4's compensation: "the startup shape probes that already exist — `packages/server/src/kernel/database.ts:27-29` selects from `outbox` and `mutation_batches` at child start — fail the candidate before it serves."

**Why it is incomplete.** The probes at `database.ts:25-29` cover `topics`, `messages`, `outbox`, `mutation_batches` and `idempotency`. They do not cover `public_paths`, and on MySQL the app role has `DROP` on the whole database (§3.3). So the compensation §14.4 item 4 offers covers three of the four boot-owned tables. A migration that drops `public_paths` passes health, goes live, and boot's page allowlist read fails afterwards — at page-serving time, not at cutover time.

**Change.** §14.4 item 4 must name all four tables and require `public_paths` to be added to the child's startup shape probe as part of step 6 (and of the base-work item 21 change that introduces the table). While there, §6.10 should note that `public-pages.ts`'s missing-table branch falls back to `PRAGMA user_version` two lines below the `tableExists` site it cites — see finding 19.

---

## 19. Step 4 deletes `user_version`, and one fail-closed branch depends on it

**Severity: operational-gap.**

**Doc.** §13 step 4: "Delete the `user_version` ladders at `packages/boot/src/boot-schema.ts:37-85` and `packages/server/src/kernel/database.ts:21-87`". §7.3: "`user_version` is a SQLite concept, so the adopt step is SQLite-only by construction."

**Why it matters.** `public-pages.ts:67-76` uses `user_version` as a discriminator, not as a version: when `topics` is absent it reads `PRAGMA user_version` and treats `0` as "boot-only store, the editable app has not created its domain schema yet" (allow the page write) and anything else as `PublicPagesUnavailable` (refuse). After step 4 nothing stamps `user_version`, so it reads `0` forever on SQLite, and the branch flips from fail-closed to fail-open: a store whose `topics` table was dropped by a bad migration now admits page writes instead of refusing them. On a remote engine the pragma does not exist at all and the branch has no meaning.

**Change.** Add `public-pages.ts` to step 4's file list and specify the replacement discriminator: the `app_store_initialized` marker in the boot store, or the presence of a row in the app's migration ledger. State the direction explicitly — absent evidence must refuse, not admit. This is a SQLite-path regression that step 4 introduces on its own, so it belongs in the step that "must stay green" on SQLite.

---

## 20. `dropClone` on Postgres cannot drop a database anything is connected to

**Severity: imprecise.**

**Doc.** §5.2: "`dropClone` — `REVOKE CONNECT ON DATABASE <clone> FROM PUBLIC` then `DROP DATABASE <clone>`."

**Why it is wrong.** `REVOKE … FROM PUBLIC` does not disconnect existing sessions and does not revoke the owner's own access, and `DROP DATABASE` fails with `database "…" is being accessed by other users` while any session remains — including one the drop's own pooled connection left behind against the clone. The doc has the right tool for this three paragraphs later in §10.3 (`pg_terminate_backend`) and does not reuse it.

**Change.** §5.2's `dropClone` cell becomes: revoke `CONNECT` from `PUBLIC` and from the app role, terminate remaining backends with `pg_terminate_backend`, then `DROP DATABASE … WITH (FORCE)` where the server version allows it. Add that a failed drop is not fatal and falls through to `reapClones`, and that `DbOps` never holds a connection to a clone it is about to drop.

---

## 21. The transfer omits the tables that gate startup, and §15.1's inventory is illustrative without saying so

**Severity: operational-gap.**

**Doc.** §15.1's boot inventory lists fifteen tables. §15.3 step 7: "Copy every remaining table, boot store first, in dependency order."

**Why it matters.** The boot store has more tables than the inventory: `auth_challenges`, `child_attempts`, `cutover`, `db_restore_requests`, `mint_receipts`, `refresh_idempotency`, `topic_moves`, `topic_page_moves`, `reaction_idempotency`, `read_idempotency`, `topic_idempotency`. Several are recovery journals whose contents change what boot does at the next start. `child_attempts` rows with `opened=1 AND closed=0` make `ChildAttempts.recover` fail `child_closure_unproven` (`child-attempts.ts:58`) unless the `boot_id` differs; the `receipt` column holds a path on the old box. `cutover` and `db_restore_requests` rows make `recoveryIntents` non-empty, which refuses restores (`database-restore.ts:209`) and reloads (`cutover.ts:108`).

Step 1 refuses to run with any of those pending, so the intended state is clean — but the doc should say what the transfer does with the rows that remain: a transferred `child_attempts` table carries receipt paths that only make sense on the source box, and a transfer to a new host with the same volume mount would reproduce them.

**Change.** Mark §15.1's table as illustrative and point at the authoritative list (the migration ladder). Add a step between 7 and 8: after copying, the transfer clears process-lifetime evidence — `child_attempts` rows are closed (their referent processes are proven dead by step 2) and `boot_id` is reset — and asserts that `cutover`, `db_restore_requests`, `topic_moves` and `topic_page_moves` are empty, failing the transfer if they are not. Add to step 9's verification that `recoveryIntents` against the target is zero.

---

## 22. §9.1's concurrency claim is undone by §9.2, and §14.5 still sells it

**Severity: imprecise.**

**Doc.** §9.1: "On Postgres this is *stronger* than it is today, not weaker: the same serialization guarantee **without a file-level lock, so unrelated transactions no longer wait**." §9.3: contention "narrows to the `seq` row, which is a straight improvement." §14.5 lists read concurrency as something SQLite gives up.

**Why it is misleading.** §9.2 then puts `SELECT epoch FROM kernel_writer FOR SHARE` at the head of every read transaction and relies on it blocking the writer's `UPDATE`. Readers and writers therefore serialize on one row on every engine, which is what §9.2 says it wants ("readers and writers serialize on one row exactly as they serialize on the file today"). The read-concurrency improvement §9.1 and §14.5 advertise does not survive §9.2, and the isolation level is not the load-bearing part of the read snapshot — the row lock is. That matters for a reader deciding whether to take this track: one read path that forgets the prelude loses the guarantee silently, with no error and no failing test, which is the same failure shape §6.7 calls "the worst failure shape in the whole list".

**Change.** Add one sentence to §9.1 and one to §14.5: with the §9.2 prelude, reads and writes still fully serialize on `kernel_writer` on every engine, so the remote engines buy durability and hosting flexibility, not read concurrency. In §9.2, state that the prelude is mandatory on every read path that composes `publishedMessages` and that a missing prelude is silent, then require a test that asserts the prelude's presence at each of the six sites (a compiled-SQL assertion, like the three in §12.3's cheap list).

---

---

# Second pass: §14.4 and §15 under the all-three-engines requirement

Re-read at md5 `ff455c7e812034c17996bc11699af9c4`, 1203 lines. The diff against the revision above is cosmetic in §14.4 and §15 (wording in §12.4, §14.3, and a new closing paragraph in §17), so findings 1 to 22 stand unchanged. Section numbers in this pass use the current layout: §14 at line 1012, §15 at 1099, §16 open questions at 1163, §17 corrections at 1178.

**The `Migrator` ledger-ordering claim in §14.4 item 1 is accurate.** Verified in the vendored source: `insertMigrations(required…)` for the whole batch is at `Migrator.ts:264`, the `Effect.forEach(required, … runMigration)` that actually runs them is at `:276`, the enclosing `sql.withTransaction(run)` is at `:308`, and the `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` is at `:225`. The ledger does claim the whole batch before the first migration executes. Seven further findings follow.

---

## 23. After a successful transfer the source stores stay live, and the default configuration points back at them

**Severity: loses-a-write.**

**Doc.** §15.3 step 11: "**Switch the descriptors.** The operator sets `DATABASE_URL` and `BOOT_DATABASE_URL` and restarts the container. Nothing in comms rewrites the operator's environment." §15.4: "the source is untouched".

**Why it is dangerous.** R1's default is that *unset* database URLs mean SQLite files under `/data`. After a SQLite-to-Postgres transfer, `/data/boot.db` and `/data/comms.db` are still there, still openable, still a complete and internally consistent board — just frozen at the transfer instant. The only thing keeping them out of service is two environment variables that live outside comms, on a platform the doc does not control. "The source is untouched" is exactly what makes this bad: an untouched store is an indistinguishable store.

**Concrete scenario.** The transfer succeeds on Monday. Three weeks later a deploy rolls back a service configuration, or a platform migration drops the variables, or someone copies the service without its secrets. Boot starts, finds no URLs, takes the documented default, opens `/data/boot.db` and `/data/comms.db`, and serves. Three weeks of messages, events, versions, generations and newly enrolled agents are gone, `seq.next` is three weeks behind so new messages are handed sequence numbers that already name other messages in the Postgres store, and every agent's cursor is silently wrong. Nothing in the system reports an anomaly: the schema is valid, the fence is installed, the shape probes pass.

**Change.** Add a step 13 to §15.3: on success the transfer stamps both source stores as transferred (a `settings` row in the boot store carrying the target's engine, database name and the transfer's timestamp, and the same in the app store's boot-owned identity row from finding 9), and boot refuses to open a store carrying that stamp, with a diagnostic naming where the board went. Say in §15.4 that leaving the source readable is deliberate — it is the way back — but that reachable-by-default is not the same as reversible, and reversal is re-running the transfer in the other direction, which also clears the stamp. This is the single cheapest guard in the whole section and it closes the failure the section's own "the source is untouched" creates.

---

## 24. An interrupted transfer leaves a target that nothing can tell is incomplete

**Severity: loses-a-write.**

**Doc.** §15.4: "**A partially written target.** Steps 7 and 9 can fail with rows already in the target. The target is left in place and the source is untouched, so the recovery is 'drop the target database and run it again'."

**Why it is not enough.** That recovery depends entirely on the operator remembering. The target carries no evidence of its own incompleteness: step 4 has run the full migration ladder, so the schema is correct and current; step 6 has written a verified `seq` with the right `next` and `published_through`; step 7 has copied some prefix of the tables. Every startup check comms has — the migration ledger's max applied id (§7.4), the shape probes (`database.ts:25-29`), the `app_store_initialized` marker, the writer fence — passes on a half-copied store.

**Concrete scenario.** The transfer is interrupted during step 7 with the boot store fully copied and the app store at 60% of `messages`. The operator sees the failure, intends to retry, gets pulled away. Two days later they set the environment variables and start the container, believing the transfer finished. Boot opens a complete boot store: the full event log, correct `seq.next`, every token and passkey. The app store has 60% of the board. Boot's recovery reconciles cleanly, because the three shared recovery tables copied early and agree. The board serves with 40% of its messages missing and their `message.created` events still in the log — which is the exact shape `SPEC.md` §6.1 reserves for `db.restored`, except that no `db.restored` event was ever written, so no consumer can tell the messages are gone rather than merely unfetched.

**Change.** §15.3 gains a first write and a last write. Immediately after step 4, the transfer inserts a `transfer_state` row into the target boot store recording the source descriptors, the start time and `state='in_progress'`; step 9 flips it to `'complete'` only after verification passes, in the same transaction as the last verified count. Boot refuses to start against a boot store whose `transfer_state` exists and is not `'complete'`, naming the incomplete transfer in the diagnostic. Rewrite §15.4's first paragraph around that marker instead of around operator memory, and state that the marker is what makes "drop the target and run it again" a detectable requirement rather than a remembered one.

---

## 25. Step 9 verifies text and counts, and the columns whose silent corruption is unrecoverable are blobs

**Severity: wedges-recovery.**

**Doc.** §15.3 step 9: "Row counts per table, `MAX(seq)` in `events`, `MAX(seq)` in `messages` and `outbox`, `seq.next`, `seq.published_through`, and a content hash over `messages(id, seq, body)` and `tokens(hash)`." §15.2: "the `Schema` decoders that already exist for every row. It validates as it goes, because a row that will not decode on the way out is a row that would have been silently mangled by a textual dump."

**Why it is the wrong set.** §15.1's own inventory says "Losing `passkeys` locks the human out permanently" and "Losing `versions` loses every undo". Neither is in the verification. Both are binary: `passkeys.public_key` and `versions.content`/`previous_content` and `staging.content` and `source_changes` are `BLOB` on SQLite, `bytea` on Postgres, `LONGBLOB` on MySQL (§7.2), and binary round-tripping across three drivers is precisely where a silent mangling happens — a `bytea` returned as a hex-prefixed string, a `LONGBLOB` coerced through a UTF-8 text path, a zero byte truncating a value. A row count and a hash over `messages.body` cannot see any of it. §15.2's claim that decoding catches it is only as strong as the decoders: `Schema.Uint8Array` is declared for source blobs (`source-schema.ts:28`), but a driver that hands back a `Uint8Array` of the *wrong bytes* decodes perfectly.

**Concrete scenario.** A board transfers to MySQL. `passkeys.public_key` round-trips through a text path and comes back with three bytes changed. Every count matches, both hashes match, verification passes, the operator switches and restarts. The board serves. The human's next login fails WebAuthn verification, and so does the next, and every human-only action — `POST /_boot/db/restore`, `revert {withDb}`, breaking the edit lock — is now impossible. `SPEC.md` §7.4's recovery for that state is "a shell into the box to clear `passkeys`", which also invalidates nothing else but requires infrastructure access, and the transfer that caused it is three days in the past with the source possibly already reused.

**Change.** Step 9's hash set becomes every column the board cannot regenerate, blobs first: `passkeys(id, public_key, counter)`, `versions(id, sha, content)` and its previous images, `staging(lock_id, path, sha, content)`, `source_changes`, `tokens(hash)`, `refresh_receipts(salt, nonce, ciphertext, tag)`, and `messages(id, seq, body, tags, meta)`. Hash the bytes, not the decoded value, and compare source to target with the same function on both sides. Add a line to §15.2 saying that decoding validates shape and the hash validates content, and that binary columns need the second because the first cannot see them. Add a transfer round-trip test for blob fidelity to §13 step 8's acceptance, which today checks "every message id and every token hash" and no binary column at all.

---

## 26. §14.4 item 1's compensation covers the cutover path only, and the human restore path runs the same non-atomic batch with no rehearsal

**Severity: wedges-recovery.**

**Doc.** §14.4 item 1: "**Compensation, in three layers.** First and most important, R6: rehearsal runs the real migration against a real copy in a real candidate process before the live store is touched (`SPEC.md` §7.4, §7.7 step 2). A migration that fails deterministically never reaches the live store on any engine, MySQL included. Second, `SPEC.md` §7.7 step 5 takes a backup after the freeze and the drain and before `go`, and step 8 restores it when health fails."

**Why the coverage is incomplete.** Both cited mechanisms belong to the cutover. There is a second path on which app migrations run against the live store, and it has neither: `POST /_boot/db/restore`. `database-restore.ts:124-132` launches a candidate from the current good generation against the *just-restored* store and gives it five seconds to reach health. The child's startup runs `Migrator` (`migrations.ts:45-48`) to bring the restored store's schema forward to the running source's — the schema gap is precisely why `SPEC.md` §7.5 warns about `incompatible_schema` on the source-revert side. No rehearsal runs against the restored content, and the only backup in hand is the pre-restore safety copy, which is the state the human is trying to leave.

**Concrete scenario (MySQL).** A destructive `POST /api/sql` at 14:00. The human restores the 13:00 backup. The current source is two migrations ahead of that backup. The candidate opens the restored store and runs both; the second fails on real 13:00 rows that the rehearsal against 14:00 data never saw. MySQL has already implicitly committed the ledger claiming both applied and has applied the first. Health fails. `install` fails, `resume` runs `rollback`, `backup.restore(safety_backup)` puts back the 14:00 store — with the destroyed rows. The human's restore is impossible, the failure repeats identically on every retry, and the only remaining route is `revert {generation, withDb}` to a generation old enough to match the backup's schema. On Postgres the same sequence rolls the batch back and the restore succeeds.

**Change.** §14.4 item 1's compensation list gains the restore path explicitly, and the restore path gains a rehearsal: before `install` activates a candidate against a restored store, clone the restored store and run the same real-candidate self-test §7.7 step 2 runs, failing the restore with a distinct code when the forward migration does not apply. That is cheap, because `DbOps.cloneForRehearsal` and the `supervisor.launch` rehearsal mode already exist and §10.4's drill is the same shape. Add a sentence to §14.4 item 1's "what remains genuinely weaker" naming the restore path as the place where a half-applied MySQL batch is most likely to be reached, and add the restore case to §12.3 test 3, which today asserts only the cutover recovery.

---

## 27. The implicit commit releases the epoch gate mid-migration, and the doc does not say what that permits

**Severity: weakens-a-stated-guarantee.**

**Doc.** §14.4 item 1's second consequence: "The outer transaction's epoch gate commits with it, so the gate is checked but is no longer atomic with the DDL it guards." §7.1: "the outer transaction is what holds the epoch gate at `migrations.ts:47`, and it should stay."

**Why the statement understates it.** `SPEC.md` §6.3 is explicit that the gate "acquires the writer lock and rejects stale processes before sequence reservation or domain writes", and the mechanism is a row lock held for the transaction's duration. On MySQL the first DDL statement commits the transaction, which releases that row lock. The candidate then continues issuing DDL against a store it no longer holds the fence on. So it is not only that the check is not atomic with the DDL — it is that a second writer can legally acquire the fence *while the first is still running migrations*, and nothing re-checks.

**Concrete scenario (MySQL).** A cutover reaches `go`. The candidate takes the gate and starts a five-migration batch. Migration 1's `CREATE INDEX` implicitly commits; the gate lock is gone. The candidate's remaining migrations are slow. The 5-second deadline at `cutover.ts:226` fires, the cutover's failure path runs `recovery.prepare(freshEpoch)` (`cutover.ts:68`), which installs a new epoch — while the candidate process is still alive and still issuing `ALTER TABLE` against the same store. Boot then restores the pre-flip backup on a target the abandoned candidate is still writing DDL to. On SQLite and Postgres the candidate's transaction holds the row and boot's `UPDATE` waits; on MySQL there is nothing to wait for.

The same implicit commit weakens the ledger lock: `Migrator`'s `LOCK TABLE … ACCESS EXCLUSIVE` is Postgres-only (`Migrator.ts:225` has `orElse: () => Effect.void`), so MySQL's only concurrency defence is the unique violation on the batch insert — which stops being a defence once that insert has committed at the first DDL, because a second process then reads the ledger as fully applied and proceeds against a half-migrated schema.

**Change.** §14.4 item 1 gains a compensation for its second consequence rather than only a statement of it: on MySQL the migration runner re-asserts the epoch gate as its own statement before each migration in the batch and aborts the batch when the epoch has changed, so a fenced-out candidate stops at the next boundary instead of running to the end. Say that this makes the gate per-migration rather than per-batch on MySQL, which is the honest weakening. Add to §12.3 test 3 the assertion that a candidate whose epoch is replaced mid-batch stops before its next migration. Note in §7.1 that the ledger lock is Postgres-only, since that section currently says concurrent migration "is handled for free" without qualifying the engine.

---

## 28. The transfer's downtime expires every in-flight refresh receipt, and a replay afterwards revokes the family

**Severity: operational-gap.**

**Doc.** §15.5: "It is not replication, it is not live migration, and it is not zero-downtime. The board is down for the duration". §16 item 7 asks for the duration to be measured. Neither says what the downtime does to credentials.

**Why it matters.** `SPEC.md` §4.4 and §3 give refresh its replay guarantee through `refresh_receipts` and `refresh_idempotency`, both of which carry short expiries — a 60-second grace window in §14's summary. An agent whose refresh response was lost replays the predecessor inside that window and gets the same pair back. Outside it, presenting a rotated predecessor is real reuse, and real reuse revokes the family. §7.6 then applies the edit-lock effects of a family revocation.

**Concrete scenario.** An agent posts a refresh at the instant the operator stops the container for a 20-minute transfer. Boot rotated and committed; the response never arrived. Twenty-five minutes later the board is back on Postgres with the receipt faithfully copied and long expired. The agent retries its refresh with the predecessor it still holds. That is reuse: the family is revoked, the agent's access and refresh tokens die, and if it held the edit lock, the lock is released with its staging dropped. The agent cannot re-authenticate without a device-code enrollment and a passkey tap from the human, who is the person who just did the migration and now thinks it broke their agents.

**Change.** §15.5 gains a paragraph on credential state across the window: access tokens (24 h) and sessions survive, enrollments survive, but any refresh in flight at shutdown cannot be replayed after a transfer longer than the grace window, and the retry is indistinguishable from theft, so the family is revoked by design. Tell the operator to quiesce agents before step 1 and to expect that any agent mid-refresh will need re-enrollment. Add `refresh_idempotency`, `auth_challenges` and `mint_receipts` to §15.1's boot inventory, which lists `refresh_receipts` but not the tables that complete the same contract, so that a *short* transfer preserves the window rather than losing it to an omitted table.

---

## 29. A pending sequence reservation is not a recovery intent, so it transfers and is resolved after verification

**Severity: imprecise.**

**Doc.** §15.3 step 1: "**Refuse to run while anything is alive.** No live child, no candidate, no pending cutover, no pending restore, no pending source publication. The command reads the same recovery intents that `packages/boot/src/recovery-intents.ts` already exposes". Step 10: "`AppRecovery.prepare` against the target … so the fence is fresh and any pending reservation is resolved from committed evidence in the target."

**Why the ordering is wrong.** `recoveryIntents` reads exactly four things — `cutover`, `db_restore_requests`, `topic_moves`/`topic_page_moves` and `source_batches` — and an outstanding sequence reservation (`seq.pending_id` non-null, `events.ts:55-58`) is none of them. So a board quiesced with an unresolved reservation passes step 1. Step 6 copies that `seq` row, step 7 copies `event_batches`, `outbox` and `mutation_batches`, step 9 verifies source against target, and step 10 then *resolves* the reservation against the target — appending events and advancing `published_through` on the target only. The verification therefore ran against a state the transfer immediately leaves, and re-running it to reassure a nervous operator reports a mismatch that is not a fault. The resolution itself is correct; its position in the order is not.

**Change.** Add `seq.pending_id IS NOT NULL` to step 1's refusal list and to `recoveryIntents` itself, so the source resolves its own reservation before the transfer starts and the target is a faithful copy from step 6 onwards. Move step 10's `prepare` to run before step 9 if the refusal is not added, so verification is the last thing that touches either store. While editing step 8, note the empty-table case: `setval(…, (SELECT MAX(n) FROM generations))` fails on `NULL`, so the fixup needs a `COALESCE` to the sequence's start value for a table with no rows.

---

## What I could not break

Recorded so the verifier knows what was covered and found sound.

1. **`SECURITY DEFINER` rejection (§9.5).** The reasoning holds. Cross-database transactions genuinely require two-phase commit on both Postgres and MySQL, so R2's shape makes the shortcut impossible outside the §3.4 fallback; and reason 3 (recovery needs committed evidence in the app store for the crash-mid-commit case, not just an atomic append) is the one that would still stand even in the two-schema shape.
2. **Pre-flip backup consistency after the drain (§10.1).** Once writers are drained and closure is proven, `pg_dump -Fc` and `mysqldump --single-transaction` on an all-InnoDB store are as consistent as `VACUUM INTO`. The guarantee rests on the freeze, exactly as the section says. This holds *given* the dump runs with a role that can read every table (finding 3).
3. **The keeper receipt as closure evidence for a remote store (R8, §10.3).** I could not construct an orphaned-child-commits-after-the-pointer-moves scenario. Process exit closes the child's TCP sockets; the server aborts its open transactions; a half-open connection cannot commit new work because the process that would send the commit is gone. Anything it committed before dying is in the store the backup was taken from. The receipt remains necessary and sufficient for the local child.
4. **`REVOKE CONNECT` plus `pg_terminate_backend` as a second check (§10.3).** Correct as stated, including the caveat that a terminated backend may have committed before it died, which is why it can never replace the receipt.
5. **R3, the boot credential never in the child environment.** `supervisor.ts:112-124` builds an explicit map with no inheritance, and the rehearsal branch already omits `BOOT_URL` and `BOOT_SECRET`. Adding `APP_STORE` to that map does not create a path for `BOOT_DATABASE_URL`, during rehearsal or during a drill, since both go through the same `launch` seam. The only leak I found is indirect, through diagnostics (finding 17).
6. **The reservation and publication-fence semantics themselves.** Setting aside the allocator's atomicity (finding 1), the one-outstanding-reservation rule, the `event_batches` state machine, the replay comparison against retained events, and the "never abort on timeout" rule are all expressed in portable statements whose meaning does not change per engine.
7. **The adopt step being safe to run twice (§7.3).** The `tableExists("boot_migrations")` early return makes it idempotent, the fresh-store branch is a no-op, and running it inside the migrator's transaction closes the crash window. It is correctly scoped to SQLite.
8. **Two app children during cutover on a remote engine.** The conditional epoch `UPDATE` takes a row lock on every engine, so the stale writer is rejected; the pre-warm/`go` ordering means the candidate installs its epoch only after the live writer is drained. I found no accepted-write loss from a double writer beyond the allocator race in finding 1.
9. **The MySQL partial-index substitute (§7.2, §14.4 item 2).** A stored generated column that is `1` or `NULL` plus a unique index is exactly equivalent, because MySQL's unique indexes ignore `NULL`. The claim "nothing weakens" is right.
10. **The MySQL `RETURNING` substitutes (§6.8, §14.4 item 3).** The select-after-write is correct under the lock the write already took, and the doc correctly identifies the `DELETE` case as the exception that needs the opposite order. The warning against a generic helper is the right call.
11. **Steps 1 through 4 shipping one at a time with SQLite green.** Each is independently revertible and testable as written. The two exceptions are recorded as findings 9 (step 1's "zero behaviour change" is false for the store-existence check) and 19 (step 4 flips a fail-closed branch to fail-open).
12. **Event dedup and replay across a restore.** `db.restored {restored_to_seq}` plus the outbox living inside the restored store means nothing is re-shipped that the restore undid, on every engine, because the mechanism is rows rather than files. The pointer-switch form preserves this as long as finding 2 is fixed.
13. **§14.4 item 1's ledger-ordering claim.** Verified against the vendored source and accurate: the batch insert is at `Migrator.ts:264` and the run loop at `:276`, both inside the `sql.withTransaction` at `:308`. On MySQL the ledger genuinely does claim migrations the first implicit commit has not run yet. The three-layer compensation is sound for the cutover path; findings 26 and 27 are about the paths it does not cover, not about this claim.
14. **Whether a half-applied MySQL migration can reach live traffic through a cutover.** It cannot. The cutover journal row is written at `cutover.ts:215` before `go`, so the failure path always finds a record and always restores the step-5 backup, and the ledger lives inside the store being restored, so the ledger and the schema come back consistent together. `runMigration` converts a failure into a defect (`Migrator.ts` `runMigration`), which kills the candidate rather than letting it report health. The gap is the restore path (finding 26), not the cutover path.
15. **§15's refusal-and-closure preconditions.** Steps 1 and 2 are the right two gates in the right order, and reusing `recoveryIntents` and `supervisor.assertClosure` rather than inventing a second notion of "quiet" is correct. The only thing missing from the refusal set is an outstanding sequence reservation (finding 29).
16. **Regenerating the target schema from the ladder rather than copying DDL (§15.3 step 4), and comparing ledgers (step 5).** Right call, and the `BootSchemaTooNew` symmetry is right. It is undermined only by the app ladder being agent-authored (finding 12), not by the approach.
17. **The identity-sequence fixups (§15.3 step 8).** `setval` to `MAX`, `ALTER TABLE … AUTO_INCREMENT = max+1`, and the `sqlite_sequence` row each leave the next generated value one past the highest copied value on their engine. The only hole is the empty-table case, folded into finding 29.
18. **"Both stores move together or the transfer is refused" (§15.1).** Correct as a rule, and the reasoning about `seq.next`/`published_through` moving first is exactly right: `SPEC.md` §6.3's "never reused, including across restores" is the invariant that would break, and transferring the allocator before anything else is the cheapest way to protect it. It is procedural rather than enforced, which is findings 23 and 24.
