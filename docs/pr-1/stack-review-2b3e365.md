# Review of the SQLite database stack at `2b3e365`

Three stacked draft PRs on `CryogenicPlanet/artifactory`, reviewed against `docs/database.md` (revision of 2026-09-11), `docs/pr-1/pr-comments.md` item 23 and the `SPEC.md` §12 bullets dated 2026-09-10.

| PR | Branch | Head | Base |
| --- | --- | --- | --- |
| #2 | `codex/database-store-descriptors-final` | `e954e70` | `codex/build-comms-core` (`5d96c1d`) |
| #3 | `codex/sqlite-store-identity` | `7d79b18` | PR #2 |
| #4 | `codex/sqlite-db-ops` | `2b3e365` | PR #3 |

Measured at the worktree, with `packages/*/src` as production and `packages/*/test` as test:

| PR | src | test | total |
| --- | --- | --- | --- |
| #2 | +110 −26 | +137 −14 | +357 −48 |
| #3 | +250 −16 | +399 −32 | +649 −48 |
| #4 | +120 −73 | +306 −76 | +428 −150 |

PR #4's body claims "38 production lines". The measured figure is +120 −73 across `packages/boot/src`, `packages/server/src` and `packages/storage/src`, net +47. The two are reconcilable only if renamed and moved lines are excluded; the body should say which accounting it used.

---

## 1. What each PR actually changes, against the design's steps 1 and 2

### PR #2 — store descriptors

**Files.** New workspace `packages/storage` (`src/store.ts` 51 lines, `src/client.ts` 12 lines, `package.json`, `tsconfig.json`, `docs/README.md`, `test/store.test.ts`). Edits to `packages/boot/src/{app-backup,app-recovery,app-store-layout,cutover,database-restore,index,linux-ownership,restore-generation,supervisor}.ts`, `packages/server/src/{server.ts,kernel/boot-channel.ts,kernel/sql-read.ts}`, `packages/server/stage-runtime.ts`, `scripts/check-invariants.ts`, `Dockerfile`, both lockfiles and three `package.json` files. One new integration test, `packages/server/test/store-descriptor-compatibility.test.ts`.

**Design step 1, element by element.**

| Design element (§13 step 1) | Status |
| --- | --- |
| `store.ts` with the parser | **Done differently.** `packages/storage/src/store.ts:21` implements `parse`, not `packages/boot/src/store.ts`. Section 2 judges the relocation. |
| `dialectOf`, `withDatabase`, `asBoot` | **Deferred**, unmentioned. Zero occurrences in `packages/`. Defensible while only `file:` exists; `asBoot` and `withDatabase` have no meaning without a second engine. |
| `render` | **Done differently.** `store.ts:17` returns `string`, not `Redacted.Redacted`. It percent-encodes each path segment, which the design's §4.1 grammar does not describe. See section 2. |
| `redactUrls` at the stderr sites | **Deferred, and not admitted.** Zero occurrences. `supervisor.ts:90`, `:91` and `cutover.ts:319`, `:323` still redact with `redactHex` alone. The PR body's "remote descriptors fail without exposing contents" is a different property: `parse` refuses `postgres:`/`mysql:` without echoing the input (`store.ts:23`, asserted at `test/store.test.ts:33`). It says nothing about a child's stderr tail. |
| `clientLayer` | **Done.** `client.ts:6`, `disableWAL: true` pinned, `readonly` and `busyTimeout` passed through. Every former direct `SqliteClient.layer` call in `packages/boot/src` and `packages/server/src` now routes through it. |
| `APP_DATABASE` → `APP_STORE` | **Partly.** `supervisor.ts:128` emits `APP_STORE`; `:129` still emits `APP_DATABASE`. `boot-channel.ts:31-33` reads the descriptor through `Config.Redacted` and cross-checks the alias. Section 2 judges the alias. |
| `AppRecovery.filename` → `AppRecovery.store` as a `Ref` | **Partly, and not as a `Ref`.** `app-recovery.ts:21-26` adds `store` as a plain constant next to the retained `filename`. Every `launch` call now passes `recovery.store` (`supervisor.ts:246`, `cutover.ts:220`, `database-restore.ts:152`). Harmless on SQLite, where the design says the `Ref` never changes; it is the whole mechanism on a remote engine, and PR #4 admits it ("no authoritative-pointer mutation"). |
| The two `fs.exists` checks replaced | **Done differently.** Both survive. `app-recovery.ts:32` and `cutover.ts:182` still call `fs.exists`; PR #3 adds the identity check in front of the first rather than in place of it. On SQLite this is belt and braces and strictly safer. The remote form the design asked for does not exist yet. |
| Fixture consolidation (§12.4, 47 files through one `test/fixtures/store.ts`) | **Deferred, and not admitted in any of the three bodies.** 68 test files still construct `SqliteClient.layer` directly. `packages/boot/test/fixtures/store.ts` exists but is the pre-existing `bun:sqlite` inspection helper, unrelated. No `COMMS_TEST_ENGINE`. This is the one piece the design says is provably behaviour-preserving *only* while a single engine exists, so deferring it makes it strictly more expensive. |
| Store identity, `store_identity`, `app_store_id` | **Deferred to PR #3**, admitted. |

Two things PR #2 does that the design does not ask for and that are right: the keeper (`linux-ownership.ts:102`) validates the descriptor against the alias before file authorization and rewrites both for its private rehearsal copy (`:127-128`), and `check-invariants.ts:35` extends the workspace-import guard to permit `boot → storage` and `server → storage` and nothing else.

### PR #3 — store identity

**Files.** New `packages/boot/src/app-store-identity.ts` (154 lines). Edits to `app-backup.ts`, `app-recovery.ts`, `backup-http.ts`, `backup-metadata.ts`, `boot-schema.ts` (one rung, 16 → 17), `cutover.ts`, `database-restore-http.ts`, `database-restore.ts`, `edit-failure.ts`, `event-http.ts`, `events.ts`, `index.ts`. New `packages/boot/test/app-store-identity.test.ts` (205 lines) plus a fixture and 22 fixture updates.

| Design element (§3.5, §10.3) | Status |
| --- | --- |
| `store_identity` table in the app store | **Done.** `app-store-identity.ts:146` creates `(singleton, store_id, initialized_at, transferred_to)`, the design's exact shape. |
| `app_store_id` setting in the boot store | **Done.** `app-store-identity.ts:131`. |
| `app_store_database` setting | **Deferred.** Zero occurrences. PR #4 admits it as "no authoritative-pointer mutation". |
| `app_store_missing` from identity rather than `fs.exists` | **Done differently.** `verifyAppIdentity` (`:140-159`) raises `app_store_missing` on an absent table, an absent row or a foreign `store_id`, inside the same app transaction and before the fence (`app-recovery.ts:47` precedes `:54`). The `fs.exists` checks remain alongside. A new code, `app_store_identity_invalid`, covers malformed state; the design had only `app_store_missing`. |
| Adoption of an existing pre-identity store | **Added, not in the design.** `mode: "legacy"` at `app-store-identity.ts:113`, plus the backup stamp at `:119`. Section 2 judges it. |
| Crash protocol | **Added, not in the design.** `reserve` / `complete` two-phase, `app-store-identity.ts:95` and `:126`, finalized at `app-recovery.ts:118` after the app store fsync at `:115-117`. Section 2 judges it; it is better than what the design specifies. |

PR #3 also fixes something the design did not name: `cutover.ts`'s rollback path gained the `fs.stat` and `fs.realPath` checks that `database-restore.ts` already had. The design (§10.2) said only that `cutover.ts:65` needed the extension fix and that `database-restore.ts`'s `realPath` check should be kept as is; it did not notice the cutover site had no `realPath` check at all. Credit this.

### PR #4 — DbOps

**Files.** `app-backup.ts` renamed to `db-ops.ts` with `AppBackup` → `DbOps` at every call site (`cutover.ts`, `database-backup.ts`, `database-restore.ts`, `restore-generation.ts`, `index.ts`). `boot-schema.ts` gains rung 18 (`backups.engine`). New `packages/storage/src/descendant.ts` (6 lines) consumed by `packages/boot/src/public-paths.ts` and `packages/server/src/ext/core/{topics,read-marks}.ts`.

| Design element (§13 step 2) | Status |
| --- | --- |
| `clone`, `prepareClone`, `restore` moved out of `app-backup.ts` behind the §5.1 interface, SQLite implementation verbatim | **Partly.** The file is renamed and the service retagged `comms/boot/DbOps` (`db-ops.ts:87`), but the shape is the old `AppBackup` object, not `DbOpsService`. No `dialect` field, no `store` effect, no `DbOpsError`; failures are still `ChildError` (`db-ops.ts:62`). |
| `restoreInto` taking an artefact and returning a descriptor | **Half done.** `db-ops.ts:59` takes `Pick<BackupRecord, "path" \| "legacy_store_id" \| "engine">`. It returns `void`. |
| Journaled `app_store_database` in the restore transaction | **Deferred**, admitted. |
| `engine` on `backups` | **Partly.** Column added at `boot-schema.ts:124` with `DEFAULT 'sqlite'` and a `CHECK`. **No production `INSERT` names the column**: `cutover.ts:255`, `database-backup.ts:93` and `database-restore.ts:339` all rely on the default. The design says "stamped at capture from `DbOps.dialect`". See section 3. |
| Extension-aware validations, three sites | **Done differently, and better.** All three route through one `backupPath(path, dataDirectory, id)` (`backup-metadata.ts:24`), used at `cutover.ts:78`, `:80`, `database-restore.ts:60`, `:61`, `:330`. The extension is still hardcoded `.db`, but there is now exactly one place to make it engine-aware instead of three. |
| `DATA_DIR`-derived backups directory | **Done.** `backupPath` takes `dataDirectory` and never `path.dirname(recovery.filename)`. |
| Foreign-engine refusal before copying | **Done.** `db-ops.ts:62` refuses before the temp directory is created; `cutover.ts:74` and `database-restore.ts:55` refuse before the catalogue checks. |
| `capacity`, `tableExists`, `readOnlySession`, `dropClone`, `reapClones` | **Deferred**, admitted ("SQLite only"). Zero occurrences of any of the five. |
| Rehearsal-copy budget, `rehearsal_copy_timeout` | **Deferred**, not admitted. Zero occurrences of `REHEARSAL_COPY_BUDGET` or `rehearsal_copy_timeout`. |
| Success-path `dropClone` (§5.4) | **Deferred**, not admitted. On SQLite the rehearsal copy still dies with the materialized proposal tree, so nothing leaks today. |

`isDescendant` in `packages/storage/src/descendant.ts` is step 3 work (design §6.2, 41 sites) landed inside step 2, and only 7 of the 41 fragments are routed. The helper compiles to byte-identical SQLite SQL, so nothing breaks, but it puts `@comms/storage` on the *editable app's* import surface (`packages/server/src/ext/core/topics.ts:1`), which is a boundary commitment made as a side effect of a backup PR.

---

## 2. The four deviations, judged

### 2a. `@comms/storage` instead of the server re-exporting boot's `store.ts`

**Accept, and fold into the design.**

The PR's premise checks out. `packages/server/runtime/package.json` lists `protocol` and `storage` as its workspaces and does not depend on `@comms/boot`. `packages/server/stage-runtime.ts:12` deletes `main.ts` and `start.ts` from the seed, and `start.ts:1` is the only file in `packages/server/src` that imports `@comms/boot`. So the design's §4.3 "`packages/server/src/kernel/store.ts` re-exports the same parser and factory from boot" would not resolve inside a frozen editable generation. The design got this wrong.

A fourth workspace is the right answer rather than putting the code in `protocol`, for two reasons the design should record:

1. `protocol` is browser-reachable. `scripts/check-invariants.ts:36` permits `ui → protocol`, and `packages/ui/src` is bundled. `client.ts` must never be reachable from that graph, and a subpath export is a convention, not a barrier.
2. `protocol` has exactly one dependency, `effect`. `storage` needs `@effect/sql-sqlite-bun` today and `@effect/sql-pg` and `@effect/sql-mysql2` at steps 5 and 6. Putting three database drivers into the workspace the browser package depends on is worse than a fourth directory.

Replacement text for `docs/database.md` §4.3, replacing the paragraph beginning "`packages/server/src/kernel/store.ts` re-exports":

> The parser, the descriptor type, the derivations and the client-layer factory live in their own workspace, `packages/storage`, which boot and the server both depend on. They cannot live in `packages/boot` and be re-exported: `packages/server/stage-runtime.ts` builds the frozen editable runtime from `packages/server/runtime/package.json`, which lists `protocol` and `storage` and deliberately not `@comms/boot`, and it deletes `start.ts` — the one file under `packages/server/src` that imports boot — from the seed. A boot re-export would resolve in the repository and fail in every editable generation. They cannot live in `packages/protocol` either, because `scripts/check-invariants.ts` permits `ui → protocol` and the UI is bundled for a browser, while the client factory must pull `@effect/sql-sqlite-bun` now and `@effect/sql-pg` and `@effect/sql-mysql2` at steps 5 and 6. `check-invariants.ts` enforces that only `boot` and `server` may import `@comms/storage`, and the package imports neither boot nor application code.

Two changes to ask for while accepting it:

- `render` should return `Redacted.Redacted`, as §4.2 specifies, not `string` (`packages/storage/src/store.ts:17`). With `file:` there is no credential and no leak, but the return type is the thing that will force `supervisor.ts:128` and the two stderr sites to be revisited when `postgres://` lands. As a plain `string` nothing forces it, and `redactUrls` is already missing.
- The percent-encoding in `render`/`parse` is not in the design's §4.1 grammar and should be, because it makes comms' `file:` form deliberately non-RFC-8089 (`file:///path` is rejected at `store.ts:24`, pinned at `test/store.test.ts:16`). Add to §4.1: "`file:` takes a single-slash absolute path with each segment percent-encoded, so that `?`, `#` and `%` in a filename are filename characters and never connection options; `file://` and `file:///` are rejected."

### 2b. The `APP_DATABASE` alias

**Accept, and fold into the design.** The alias is load-bearing and the design missed why.

`docs/database.md` §4.4 replaces `APP_DATABASE` with `APP_STORE` in one row of a table, treating it as a rename. It is not. A boot generation's rollback target is an immutable source snapshot under `/data/gen`, and a snapshot taken before this change contains `boot-channel.ts` reading `Config.String("APP_DATABASE")`. Emitting only `APP_STORE` would make every retained pre-descriptor generation unlaunchable, which is exactly the fallback path `SPEC.md` §7.1 depends on. `packages/server/test/store-descriptor-compatibility.test.ts` pins this: it stages a generation with the pre-descriptor channel (`:14-19`), fails a candidate that deletes rows, and asserts the retained generation comes back and keeps serving.

The alias is also cross-checked rather than merely emitted: `childStore` (`store.ts:44`) fails `store_descriptor_mismatch` when the two disagree, and the keeper applies the same check before file authorization (`linux-ownership.ts:102`). That is the right shape.

When it can go: when no retained generation can predate the descriptor. `SPEC.md` §7.5 keeps the last five good generations plus the live one, so the alias is removable once the oldest retained snapshot on every deployment is descriptor-aware. That is not observable from code, so make it observable: stamp the generation row with the contract version at preparation, and drop the alias in the release where boot can refuse to launch, rather than mis-launch, a generation whose stamp is absent. Add to §4.4:

> `APP_DATABASE` is not simply renamed. Retained generations are immutable source snapshots, and one taken before this change reads `APP_DATABASE`; dropping it would make every pre-descriptor rollback target unlaunchable, which is the path `SPEC.md` §7.1 relies on. Boot emits both variables, and the child and the keeper both refuse a pair that names two different files (`store_descriptor_mismatch`). The alias is removable once no retained generation can predate the descriptor — five good generations plus the live one — which requires a per-generation contract stamp so boot can refuse an unstamped snapshot instead of launching it wrongly.

### 2c. PR #3's explicit crash protocol for identity adoption

**Accept, and fold into the design. It is safer than what §3.5 and §10.3 specify, and the design's version has a single-crash-point wedge.**

The design's protocol: mint the UUID, write `store_identity` in the app store, and write `app_store_id` plus `app_store_initialized` "in the same boot transaction that writes `app_store_initialized` at `app-recovery.ts:109`". Two stores means two transactions and no cross-store atomicity, and the design never says what happens between them. Both orderings wedge on one SIGKILL:

- App store first. The app store carries `store_id = X`; the boot store has no marker. On restart the boot store takes the fresh branch and mints `Y`. `prepare` then compares `Y` against the app store's `X` and raises `app_store_missing` forever. The board is bricked with both halves intact and no in-band way back.
- Boot store first. The marker names `X`; the app store has no `store_identity` row. `prepare` raises `app_store_missing` forever, same outcome.

PR #3 closes this by making the UUID durable before either write. `reserve` (`app-store-identity.ts:95-122`) commits an `app_store_adoption` record in the boot store carrying the UUID, the timestamp, the canonical filename and a `pending` phase, in its own boot transaction. `verifyAppIdentity` (`:140`) then runs inside the app transaction, before the fence, with `allowMissing` true only while the adoption is pending (`app-recovery.ts:47`). `complete` (`:126`) writes `app_store_id`, the marker and the `ready` flip in one boot transaction, and it is called at `app-recovery.ts:118`, after the app store and its parent directory have been fsynced at `:115-117`.

Crash points, each covered:

| SIGKILL at | Design | PR #3 |
| --- | --- | --- |
| After the UUID is chosen, before any write | Fresh mint next boot; consistent | Same |
| After `reserve`, before the app transaction | Not expressible; no record exists | Resumes the same UUID (`app-store-identity.ts:105-108`); adoption returned unchanged |
| After the app transaction commits, before the boot marker | **Wedged**: a new UUID is minted and never matches | Resumes the same UUID; `verifyAppIdentity` finds the matching row and passes |
| After the boot marker, before the app transaction | **Wedged**: marker names an id no store carries | Cannot occur: `complete` runs strictly after the app store fsync |
| After `complete` | Normal | Normal |

The tests are real SIGKILL tests, not simulations (`packages/boot/test/app-store-identity.test.ts:54`, `:65`, `:83`, `:184`).

Replacement text for `docs/database.md` §10.3, replacing the first bullet ("**The boot store journals the live app database's name.**" keeps its own text) and inserting before it:

> **Identity is adopted in two phases, because two stores cannot share a transaction.** Boot first commits an `app_store_adoption` record in the boot store — the minted UUID, the timestamp, the canonical store selection and `phase: "pending"` — in a boot transaction of its own. The app transaction then writes or verifies `store_identity`, before the writer fence changes, accepting an absent row only while the adoption is pending. Only after the app store and its parent directory are fsynced does boot commit the finalizing transaction that writes `app_store_id`, the `app_store_initialized` marker and `phase: "ready"`. An interrupted adoption resumes the reserved UUID rather than minting a second one. Writing the two halves without this reservation wedges the board on one SIGKILL in either ordering: the surviving half names an identity the other half will never agree with, and every subsequent start fails `app_store_missing` with both stores intact. A malformed or self-contradictory adoption record is the distinct `app_store_identity_invalid`, which is not the same failure as a store that is merely absent.

### 2d. Authorized stamping of pre-adoption backups

**Accept with two changes, and fold into the design.** It is needed, and it cannot be abused to stamp a foreign backup, but the stamp is written in the wrong transaction.

The design has no upgrade path. Every existing deployment's catalogued backups were taken from a store with no `store_identity` table, so after this change `restoreInto` would refuse all of them — `verifyAppIdentity` raises `app_store_missing` when the table is absent (`app-store-identity.ts:145`). A board would lose its entire restore history at upgrade, which is a durability regression the design never contemplates. Some narrow exception is required.

The exception is narrow in the right ways:

- It is recorded per row, not implied. `backups.legacy_store_id` (`boot-schema.ts:122`) is set once, at first adoption, on the rows the catalogue already held (`app-store-identity.ts:118-119`), and never again: `reserve` returns early once an adoption record exists (`:105-108`).
- It is scoped to SQLite. PR #4 adds `WHERE engine='sqlite'` (`:119`), so a catalogue carrying `pg` or `mysql` rows after a future transfer cannot be stamped. Pinned at `test/app-store-identity.test.ts:242-249`.
- It never touches the artefact. The write lands on the disposable copy in the restore staging directory (`db-ops.ts:69`, `:74-75`), not on `backup.path`. Asserted at `test/app-store-identity.test.ts:114`.
- A stamped backup that already carries a *different* identity is still refused: `verifyAppIdentity` only tolerates an absent table, and a present row with a foreign `store_id` fails regardless of the stamp (`:158`).

So a foreign backup cannot be stamped through any comms path. The residual route is an operator writing a foreign board's file into `<DATA_DIR>/backups/<id>.db` under an already-stamped id *and* dropping its `store_identity` table first. That requires filesystem write access to the data directory, which `SPEC.md` §7.9 already treats as inside the trust boundary.

Two changes to ask for:

1. **Move the stamp from `reserve` into `complete`.** Today it is written while the adoption is `pending` (`app-store-identity.ts:116-119`) and is never rolled back if the app transaction then refuses the store. A deployment whose app store turns out to be foreign is left with every backup row stamped with an identity that was never adopted. Writing it in the finalizing transaction ties the stamp to an adoption that actually completed.
2. **Add `AND legacy_store_id IS NULL` to the `UPDATE`.** It is a no-op today because the statement runs at most once, but it makes "stamped once, never re-stamped" a property of the statement rather than of its call site — which matters if a boot store is ever restored from a snapshot predating adoption.

Text to add to `docs/database.md` §10.3, after the `app_store_missing` paragraph:

> **Backups taken before identity existed.** Every artefact a deployment already holds was copied from a store with no `store_identity` table, and refusing all of them at upgrade would destroy the restore history the whole section exists to protect. At the moment boot adopts a pre-identity store it records, on each SQLite backup row already in its catalogue, the identity being adopted (`backups.legacy_store_id`), in the same transaction that finalizes the adoption and only where the column is still null. A restore may create `store_identity` on its private staging copy only when that column equals the live identity; every other artefact must already carry a matching row, and one carrying a different `store_id` is refused whatever the column says. The catalogued artefact's own bytes are never modified. This exception closes permanently the first time boot completes an adoption: no backup taken afterwards can receive it.

---

## 3. Correctness

Every claim below is against the worktree at `2b3e365`.

**The identity check runs before anything irreversible, and this holds.** In `prepare`, `verifyAppIdentity` is the first statement inside the app transaction (`app-recovery.ts:47`), ahead of the recovery-table creation at `:48-51` and the fence update at `:54`. A foreign or absent identity therefore aborts the transaction with the fence, the outbox and `mutation_batches` untouched, so no acknowledged write is resolved or discarded against the wrong store. `index.ts:163` calls `reserveIdentity` before `AppRecovery.prepare` at `:164`, and the whole block is wrapped in `Effect.exit` at `:166`, so a refusal leaves boot serving `/_boot/*` rather than dying — which is what `SPEC.md` §7.1 invariant 1 requires.

**SIGKILL between the app transaction and the boot marker does not lose or wedge anything.** Covered in section 2c. `app-recovery.ts:115-117` fsyncs the app store and its parent before `identity.complete(adoption)` at `:118`, so the ordering the protocol depends on is durable rather than incidental. `packages/boot/test/app-store-identity.test.ts:184` is the test.

**Restore of a pre-adoption backup is bounded correctly.** `db-ops.ts:74` passes `allowMissing = backup.legacy_store_id === adoption.store_id`, so an unstamped artefact must already carry a matching `store_identity` row, and the whole check runs on the staging copy before the live file is touched at `:80-82`. Section 2d covers the residual.

**A foreign-identity store named by the journal is not reachable in this stack**, because there is no journal. `app_store_database` has zero occurrences, `AppRecovery.store` is a constant (`app-recovery.ts:24`), and `restoreInto` returns `void` (`db-ops.ts:59-84`), so the live store is always `appFilename` from `index.ts:96`. The design's R13 hazard — boot starting against the pre-restore database after a remote restore — cannot occur here and also cannot be tested here. It becomes live the moment a remote engine lands, and `restoreInto`'s `void` return is what will have to change first.

**Defect: the `.restore-*` staging directories leak, and the leak is unbounded and unrecoverable in band.** PR #3 replaced the fixed staging path `${filename}.restore` (`app-backup.ts:56` at `5d96c1d`) with a fresh scoped temp directory per attempt, `fs.makeTempDirectoryScoped({ directory: path.dirname(filename), prefix: ".restore-" })` (`db-ops.ts:63-66`). The PR body admits the directories survive SIGKILL and that no reclamation is added. The consequences are worse than the admission suggests:

- The old path self-healed. A killed restore left exactly one stale file that the next restore's `fs.copyFile` overwrote. The new path leaks a full copy of the board per killed attempt, and the names never collide.
- Nothing reclaims them. `artifact-retention.ts:28` is explicit — "Only catalogued boot-owned artifacts are considered; this is not a volume scanner" — and the directories are not catalogued. `grep readDirectory packages/boot/src` finds no sweep of the store directory.
- They consume the budget that guards writes. `storageHeadroom` measures the volume through `readStorageVolume` (`storage-headroom.ts:55`), and `requireHeadroom` (`:30`) refuses when `available_bytes` falls under the policy percentage. Leaked copies reduce `available_bytes` directly. So repeated killed restores drive the board to `storage_headroom` refusals that pruning cannot clear, because the bytes belong to no catalogued row and `/_boot/status` lists only catalogued artefacts. The operator sees a board refusing writes for lack of space with nothing on the status page to delete.

The fix is small and should land before merge: either go back to a deterministic staging path under the store directory, or sweep `.restore-*` under `path.dirname(filename)` at the same point `index.ts:160-161` runs the other recovery sweeps. A deterministic path is the smaller change and restores the self-healing property.

**Defect: `backups.engine` is never written, only defaulted.** `boot-schema.ts:124` adds the column with `DEFAULT 'sqlite'`, and none of the three production inserts names it — `cutover.ts:255`, `database-backup.ts:93`, `database-restore.ts:339`. Today every row is correctly `sqlite`. The moment `DbOps` has a second implementation, a forgotten insert stamps a Postgres dump as SQLite, and the `backup_engine_mismatch` guards at `db-ops.ts:62`, `cutover.ts:74` and `database-restore.ts:55` are exactly the checks that would then pass on an artefact they should refuse. The design says "stamped at capture from `DbOps.dialect`", and it should be: name the column in all three inserts now, from a `dialect` field on the service, while `'sqlite'` is the only possible value and the change is provably inert.

**Not a defect, recorded so it is not re-litigated.** The `-wal` and `-shm` removal between the identity check and the rename (`db-ops.ts:80-81`) is unchanged from `5d96c1d` and from the design's §10.3, and depends on the same keeper closure receipt it always did. The cross-directory `fs.rename` at `:81` is still within one filesystem and still atomic.

**Unclosed risk carried into PR #4.** PR #3's Linux suite finished 722/724 with two held-marker failures in page movement and accepted source reset, cause unknown and admitted as unknown. PR #4's body says Linux, image and QEMU acceptance are pending entirely and that the earlier failures remain unexplained. Two unexplained failures in the freeze-and-drain machinery are not a merge-blocker for a SQLite-only descriptor change, but they are a merge-blocker for a PR that renames the service the restore path depends on, because a rename removes the ability to bisect against the prior name.

---

## 4. Sequencing

**The premise about the base needs correcting.** The base branch has not moved 104 commits. `git rev-list --count c4ecc7d..origin/codex/build-comms-core` is **6**, and `git ls-remote` confirms `codex/build-comms-core` is at `5d96c1d` on the remote, the same commit the worktree has. Restricted to the four named files:

```
git log --oneline c4ecc7d..origin/codex/build-comms-core -- \
  packages/boot/src/app-backup.ts packages/boot/src/app-recovery.ts \
  packages/boot/src/database-restore.ts packages/boot/src/supervisor.ts
```

returns nothing. The six commits are Linux fixture and publication-contention fixes. PR #2's merge base with the base branch is `5d96c1d` itself, so the stack is current. There is no rebase debt today.

The sequencing concern is still live, because `pr-comments.md` item 23 sequences this track after items 1 to 22 and those are not closed. `direction-check-2979676.md` names three things to correct before going further, and all three land in files this stack edits. What will actually conflict when the base moves:

1. **The boot schema rungs, highest probability.** PR #3 takes `user_version` 17 (`boot-schema.ts:122`) and PR #4 takes 18 (`:124`). `boot-schema.ts` is the single serialization point for every boot-side change, and the base still owes item 24's gate fixes, item 19's layer work and the three missing routes. Any base migration forces both rungs to renumber, and a renumber is not a textual merge: a deployment that has already run rung 17 under one meaning cannot be told it now means another. Codex should take the highest rungs last, or the base should freeze the ladder.
2. **`packages/boot/src/index.ts` layer wiring.** PR #2 changes the boot-store client construction at `:66`, PR #4 changes the `DbOps` layer at `:96`, and PR #3 adds `reserveIdentity` at `:163`. Item 19.3 asks for one layer graph and four fewer `Ref`s in exactly this file, which the direction check reports is untouched and has got worse (seven null-filled `Ref`s, eleven positional arguments). This is a genuine structural conflict, not a textual one.
3. **The `app-backup.ts` → `db-ops.ts` rename in PR #4.** Any base commit touching `app-backup.ts` becomes a rename conflict resolved by hand. None exist today; the base checklist is open.
4. **`packages/server/src/kernel/sql-read.ts`.** PR #2 edits `:65` and `:82`. Item 7 moves domain code out of `kernel/` into `ext/core/`, and the read-only SQL route is a candidate. PR #4 has already moved two other files into `ext/core/` and edits them (`topics.ts`, `read-marks.ts`), so the split is in motion underneath the stack.
5. **The boot route error tables.** PR #3 adds an `isAppStoreIdentityError` clause to `backup-http.ts:51`, `:65` and to `database-restore-http.ts`. The three routes the base still owes — `POST /_boot/restart`, `/_boot/metrics`, `revert {withDb}` — will each need the same clause, and it is currently copied rather than factored. That is a rework cost, not a conflict.

What will *not* conflict: `traffic.ts` is untouched by the stack, so item 24 point 3's request-gate change lands cleanly even though `database-restore.ts` (the gate's only remaining user) is edited by all three PRs.

---

## 5. Verdicts

**PR #2 — mergeable after the base, with two small changes.** The descriptor is clean, the workspace placement is correct and better-reasoned than the design, and the compatibility test is the right test. Before merge: make `render` return `Redacted.Redacted`, and either land `redactUrls` at the two stderr sites or say plainly in the body that it is deferred rather than implying the parser covers it. Fixture consolidation should be scheduled explicitly, now, not silently dropped: it is the only item in step 1 that gets more expensive with every week it waits.

**PR #3 — mergeable after the base, once the staging leak is fixed.** The crash protocol is the strongest work in the stack and is better than the design it implements. Two changes: fix the `.restore-*` leak (section 3), and move the backup stamp into the finalizing transaction with an `IS NULL` guard (section 2d). The two unexplained Linux failures should be explained, not carried.

**PR #4 — needs changes.** Three things. Name `engine` in all three `INSERT INTO backups` statements instead of relying on the column default, while the change is inert. Land the Linux, image and QEMU acceptance the body says is pending, because this PR renames the service the restore path depends on. And split `packages/storage/src/descendant.ts` and its three consumers out: it is step 3 work, it is 7 of 41 sites, and it commits the editable app to importing `@comms/storage` as a side effect of a backup PR.

**Two things to tell Codex before the next tranche.**

1. **Say what is deferred, every time, and say it in the body.** Three design elements are missing with no mention anywhere: `redactUrls` at the two stderr sites, the §12.4 fixture consolidation across 68 files, and the §5.3 rehearsal-copy budget. The bodies are otherwise unusually honest — PR #3 volunteers its own scratch-directory leak and refuses to explain the Linux failures it cannot explain — which is exactly why the silent omissions cost more than they would elsewhere. A short "deferred from the design, with reason" list per PR closes it.
2. **Stop starting the next step inside the current one, and stop numbering schema rungs while the base ladder is open.** `isDescendant` is step 3 landing in step 2, and the two `boot-schema` rungs are the stack's only irreversible commitment against a base that still owes migrations. Both are cheap to avoid and expensive to unwind. The corollary: when the design is wrong, as it was about the boot re-export and about upgrading a store that has no identity yet, say so in the PR and propose the replacement text. Three of the four deviations here are improvements on the design, and none of them reached `docs/database.md`.
