# chirp bloat map — measured baseline

Measured 2026-09-12 against a detached worktree of `origin/master` at commit `1156548`
("Merge pull request #8 from CryogenicPlanet/codex/database-portability-resumed"), checked out at
`/private/tmp/claude-501/-Users-cryogenicplanet-general-comms/f370fb0c-0b48-4731-a18c-45a3703a3b43/scratchpad/wt-audit`.

Every number below is counted, not estimated. The commands that produced each table are shown with it.
No cuts are proposed here; this is the shared factual map.

---

## 0. Headline

| Corpus | Files | Lines |
| --- | ---: | ---: |
| Production source (`packages/*/src`, excl. `*.test.ts`) | 261 | 25,762 |
| Tests (`packages/*/test`) | 341 | 40,544 |
| Other package code (dev launchers, staging scripts, page tooling) | 6 | 293 |
| Repo scripts + example extensions | 9 | 1,335 |
| Committed markdown (excl. `repos/`) | 56 | 13,519 |
| **Vendored third-party reference source (`repos/`)** | **5,687** | **152,654** |

Ratios that matter:

| Ratio | Value |
| --- | ---: |
| Test lines : production lines | 1.57 : 1 |
| `repos/` vendored lines : production lines | 5.92 : 1 |
| Production lines per core API operation (11 ops) | 2,342 |
| Boot lines vs. SPEC §7.1 budget (6,000–7,000) | 13,536 — **1.93×–2.26× over** |

---

## 1. Lines and files per package

```sh
cd <worktree>
for p in boot protocol server storage ui; do
  find packages/$p/src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \) \
    ! -name '*.test.ts' ! -name '*.test.tsx' ! -name '*.spec.ts' | wc -l
  find packages/$p/src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \) \
    ! -name '*.test.ts' ! -name '*.test.tsx' ! -name '*.spec.ts' -print0 | xargs -0 cat | wc -l
done
```

### Production (`packages/*/src`)

| Package | Files | Lines | Share | Mean lines/file |
| --- | ---: | ---: | ---: | ---: |
| boot | 101 | 13,536 | 52.5% | 134 |
| server | 92 | 7,315 | 28.4% | 80 |
| ui | 39 | 3,340 | 13.0% | 86 |
| storage | 9 | 810 | 3.1% | 90 |
| protocol | 20 | 761 | 3.0% | 38 |
| **Total** | **261** | **25,762** | 100% | 99 |

Zero `*.test.ts` files live inside any `src` tree — the split is clean.

### Tests (`packages/*/test`)

| Package | Test files | Test lines | Fixture/helper files | Fixture lines | Total files | Total lines | Test : prod |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| server | 129 | 14,965 | 44 | 5,544 | 173 | 20,509 | 2.80× |
| boot | 85 | 11,626 | 69 | 7,120 | 154 | 18,746 | 1.38× |
| storage | 9 | 749 | 5 | 540 | 14 | 1,289 | 1.59× |
| protocol | 0 | 0 | 0 | 0 | 0 | 0 | 0.00× |
| ui | 0 | 0 | 0 | 0 | 0 | 0 | 0.00× |
| **Total** | **223** | **27,340** | **118** | **13,204** | **341** | **40,544** | **1.57×** |

Two facts fall out: **13,204 lines (32.6%) of the test corpus is fixtures, not assertions**, and
**4,101 production lines (`protocol` + `ui`) have no test package at all**.

### Code outside `src` and `test`

| File | Lines |
| --- | ---: |
| `packages/ui/page-dev-reload.ts` | 138 |
| `packages/server/pages/tooling/evlog-sink.ts` | 65 |
| `packages/server/stage-runtime.ts` | 31 |
| `packages/ui/dev.ts` | 27 |
| `packages/ui/vite.config.ts` | 22 |
| `packages/server/stage-migrations.ts` | 10 |
| **Total** | **293** |

---

## 2. Twenty largest source files

```sh
find packages/*/src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \) -print0 \
  | xargs -0 wc -l | grep -v ' total$' | sort -rn | head -20
```

| # | Lines | File |
| ---: | ---: | --- |
| 1 | 567 | `packages/server/src/kernel/ext.ts` |
| 2 | 549 | `packages/boot/src/cutover.ts` |
| 3 | 483 | `packages/boot/src/auth.ts` |
| 4 | 463 | `packages/boot/src/proxy.ts` |
| 5 | 459 | `packages/boot/src/database-restore.ts` |
| 6 | 452 | `packages/boot/src/edit-lock.ts` |
| 7 | 448 | `packages/boot/src/supervisor.ts` |
| 8 | 441 | `packages/boot/src/edit-http.ts` |
| 9 | 413 | `packages/boot/src/source-files.ts` |
| 10 | 403 | `packages/boot/src/events.ts` |
| 11 | 377 | `packages/boot/src/auth-http.ts` |
| 12 | 365 | `packages/boot/src/event-http.ts` |
| 13 | 349 | `packages/server/src/server.ts` |
| 14 | 347 | `packages/ui/src/app.tsx` |
| 15 | 346 | `packages/boot/src/index.ts` |
| 16 | 273 | `packages/server/src/ext/core/messages.ts` |
| 17 | 272 | `packages/boot/src/route-discovery.ts` |
| 18 | 271 | `packages/boot/src/source-journal.ts` |
| 19 | 269 | `packages/server/src/kernel/boot-channel.ts` |
| 20 | 265 | `packages/protocol/src/errors.ts` |

**No single file is large.** The top 20 hold 7,812 lines — 30.3% of production. The other 241 files
hold 17,950 lines at a mean of 74. In boot specifically: mean 134, **median 84**, and the
distribution is 31 files under 50 lines, 23 at 50–99, 27 at 100–199, 11 at 200–399, 9 at 400+.
The mass is in the *count of files*, not the size of any of them.

## 3. Twenty largest test files

```sh
find packages/*/test -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 wc -l | grep -v ' total$' | sort -rn | head -20
```

| # | Lines | File |
| ---: | ---: | --- |
| 1 | 681 | `packages/boot/test/pages-http.test.ts` |
| 2 | 564 | `packages/boot/test/generations.test.ts` |
| 3 | 473 | `packages/boot/test/app-store-identity.test.ts` |
| 4 | 440 | `packages/server/test/generation-revert.test.ts` |
| 5 | 434 | `packages/server/test/fixtures/mutation-protocol.ts` |
| 6 | 428 | `packages/boot/test/events.test.ts` |
| 7 | 386 | `packages/boot/test/edit-lock.test.ts` |
| 8 | 382 | `packages/boot/test/source-files.test.ts` |
| 9 | 369 | `packages/server/test/fixtures/topic-move-faults.ts` |
| 10 | 368 | `packages/boot/test/auth-http.test.ts` |
| 11 | 360 | `packages/server/test/database-restore.test.ts` |
| 12 | 357 | `packages/boot/test/artifact-retention.test.ts` |
| 13 | 345 | `packages/boot/test/fixtures/database-restore-auth.ts` |
| 14 | 345 | `packages/boot/test/failed-recovery.test.ts` |
| 15 | 336 | `packages/boot/test/request-events.test.ts` |
| 16 | 323 | `packages/server/test/restart.test.ts` |
| 17 | 313 | `packages/boot/test/fixtures/tokens-run.ts` |
| 18 | 311 | `packages/storage/test/fixtures/remote-sessions.ts` |
| 19 | 311 | `packages/boot/test/fixtures/scheduled-backup.ts` |
| 20 | 307 | `packages/server/test/source-reset.test.ts` |

Six of the top twenty are fixtures rather than tests.

---

## 4. Mass by directory

```sh
for d in $(find packages/*/src -type d | sort); do
  find $d -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \) -print0 \
    | xargs -0 cat | wc -l
done
```

| Directory | Files | Lines | % of production |
| --- | ---: | ---: | ---: |
| `packages/boot/src` | 101 | 13,536 | 52.5% |
| `packages/ui/src` | 30 | 3,144 | 12.2% |
| `packages/server/src/kernel` | 38 | 2,947 | 11.4% |
| `packages/server/src/ext/core` | 23 | 2,107 | 8.2% |
| `packages/server/src` (top level) | 23 | 1,673 | 6.5% |
| `packages/storage/src` | 9 | 810 | 3.1% |
| `packages/protocol/src` | 20 | 761 | 3.0% |
| `packages/server/src/ext/subscriptions` | 5 | 474 | 1.8% |
| `packages/ui/src/ui` | 9 | 196 | 0.8% |
| `packages/server/src/ext` (top level) | 3 | 114 | 0.4% |
| **Total** | **261** | **25,762** | 100% |

**`packages/boot/src` has no subdirectories at all** — 101 sibling files in one flat directory,
grouped only by filename prefix:

| Filename prefix | Files | Lines |
| --- | ---: | ---: |
| `source-*` | 7 | 1,279 |
| `edit-*` | 3 | 1,131 |
| `auth-*` | 4 | 1,007 |
| `database-*` | 5 | 910 |
| `event-*` | 2 | 570 |
| `cutover` | 1 | 549 |
| `proxy` | 1 | 463 |
| `child-*` | 4 | 458 |
| `enrollment-*` | 4 | 453 |
| `app-*` | 3 | 451 |
| `supervisor` | 1 | 448 |
| `events` | 1 | 403 |
| `boot-*` | 5 | 372 |
| `index` | 1 | 346 |
| `sqlite-*` | 4 | 305 |
| `route-discovery` | 1 | 272 |
| `token-*` | 4 | 271 |
| `restore-*` | 2 | 269 |
| `settings-*` | 3 | 268 |
| `backup-*` | 3 | 259 |
| `tokens` | 1 | 257 |
| `passkey-*` | 3 | 256 |
| `public-*` | 3 | 228 |
| `preparation-*` | 2 | 215 |
| (43 further prefixes) | 41 | 2,136 |

### Boot against its own six-job charter

Every one of the 101 boot files assigned to exactly one of the owner's six jobs (assignment by
filename and by each file's leading doc comment; no file unassigned, none double-counted):

| Job | Files | Lines | % of boot |
| --- | ---: | ---: | ---: |
| 4. Snapshot and swap generations with rollback | 42 | 5,275 | 39.0% |
| 5. The edit loop | 12 | 2,483 | 18.3% |
| 2. Authenticate | 21 | 2,464 | 18.2% |
| 1. Listen and proxy | 12 | 1,509 | 11.1% |
| 3. Mint `seq` and keep the event log | 6 | 1,223 | 9.0% |
| **Outside the six** (`settings*`, `artifact-retention`) | 4 | 459 | 3.4% |
| 6. The way in when everything else is broken | 4 | 123 | 0.9% |
| **Total** | **101** | **13,536** | 100% |

Job 4 is the durability machinery. SPEC §7.1 budgets it at "roughly 2,300" lines
(`SPEC.md:401`); it measures **5,275 — 2.29× the budget**, and it alone is nearly as large as the
whole bootloader's 6,000–7,000-line budget. Job 6, the guarantee the owner ranks third and
irreducible, is **123 lines, 0.9% of boot**.

---

## 5. Runtime dependencies, and how many files use each

```sh
cat packages/*/package.json
for dep in <each>; do grep -rlE "from \"$dep(\"|/)" packages/<pkg>/src --include='*.ts' | wc -l; done
```

| Package | Declared runtime deps | Importing files (src only) |
| --- | ---: | --- |
| **boot** | 5 | `effect` 96 · `@comms/storage` 11 · `@effect/platform-bun` 5 · `@simplewebauthn/server` 4 · **`@effect/sql-sqlite-bun` 0** |
| **server** | 11 | `effect` 87 · `@comms/protocol` 38 · `@comms/storage` 20 · `@effect/platform-bun` 4 · `marked` 1 · `highlight.js` 1 · `@comms/boot` 1 · **`@effect/sql-sqlite-bun` 0** · `@tailwindcss/browser` 0* · `github-markdown-css` 0* · `mermaid` 0* |
| **ui** | 14 | `react` 27 · `effect` 22 · `lucide-react` 9 · `@comms/protocol` 4 · `@effect/atom-react` 3 · `class-variance-authority` 3 · `@effect/platform-bun` 2 · `react-dom` 2 · `@comms/server` 1 · `clsx` 1 · `marked` 1 · `motion` 1 · `tailwind-merge` 1 · `scheduler` 0 |
| **storage** | 4 | `effect` 9 · **`@effect/sql-pg` 2** · **`@effect/sql-mysql2` 1** · `@effect/sql-sqlite-bun` 1 |
| **protocol** | 1 | `effect` 19 |

\* `@tailwindcss/browser`, `github-markdown-css` and `mermaid` are never `import`ed; they are
resolved by string at runtime in `packages/server/src/page-assets.ts:6-11` and served as static
files, so they are real but invisible to the import graph.

Notes:
- Boot's **five** runtime dependencies match SPEC §7.1 exactly. One of them,
  `@effect/sql-sqlite-bun`, has **zero direct imports in `packages/boot/src`**; boot reaches SQLite
  only through `@comms/storage`.
- `packages/server/runtime/package.json` is a **second, parallel dependency manifest** (41 lines,
  23 dependencies) staged onto the volume by `stage-runtime.ts`. It re-declares the mysql2 patch.
- The repo carries two patched dependencies (`package.json:39-42`):
  `patches/@effect%2Fplatform-bun@4.0.0-rc.113.patch` (56 lines) and
  **`patches/@effect%2Fsql-mysql2@4.0.0-rc.113.patch` (78 lines)** — a patch to a MySQL driver no
  production module imports.

---

## 6. Routes served

### Boot (`packages/boot/src/route-discovery.ts`)

```sh
# 44 descriptor entries in the `routes` array; each carries 1–2 path aliases
```

| Measure | Count |
| --- | ---: |
| Route descriptors declared | 44 |
| Method + path pairs (aliases expanded) | 59 |
| Distinct paths | 48 |
| Undeclared private paths (child IPC + boot page assets) | 6 |

By method: POST 22 · GET 17 · DELETE 3 · PUT 1 · HEAD 1.
By access class: `human` 16 · `public` 12 · `fs` 11 · `read` 1 · `device-secret` 1 · `proof` 1 ·
`refresh-token` 1 · `action-dependent` 1.

Fifteen of the 44 descriptors carry a second path alias (59 pairs − 44 descriptors): the `/api/*`
aliases of the edit loop (`fs`×3, `lock`×3, `reload`, `revert`, `generations`, `tokens`×2) and the
`/auth/*` and `/approve/*` aliases of enrolment (`enroll`×2, `refresh`, `approve`). That is why 44
descriptors become 59 served pairs.

The 6 undeclared paths, excluded from discovery by the comment at `route-discovery.ts:3`:
`/_boot/seq`, `/_boot/seq/reserve`, `/_boot/seq/abort`, `/_boot/events/append`,
`/_boot/auth/client.js`, `/_boot/auth/approval.js`.

### App

| Surface | Count | Detail |
| --- | ---: | --- |
| Core API operations (`HttpApiEndpoint` in `packages/protocol/src`) | 16 | of which **3 are `legacy*` wildcard duplicates** and 1 is a `root` alias → **11 distinct operations**, exactly as SPEC §12 decides |
| `HttpRouter.add` routes in `packages/server/src` | 17 | board 5 (`/`, `/t/*`, `/ext`, `/@:agent`, `/assets/*`), onboarding 4 (`/init`, `/init.md`, `/quickstart`, `/quickstart.md`), page assets 5, `/p/*`, `/api`, `/_kernel/readiness` |
| In-tree extension routes | 5 | `sql-http.ts` `/api/sql`; `ext/subscriptions` `/api/subscriptions` ×2 + `/api/subscriptions/:id`; `ext/standup.ts` `/api/standup` |
| Example extension routes (`examples/extensions`, not shipped) | 4 | `/api/digest`, `/api/topics/*` DELETE, `/api/me` PATCH, `/api/agents` |

**Total routes the running product serves: 38 app + 59 boot pairs = 97.**
Against 25,762 production lines that is **266 lines per served route**.

The three `legacy*` endpoints are *not* backward compatibility: `legacyDetail`, `legacyMove` and
`legacyMeta` (`packages/protocol/src/topics-http.ts:28`, `topic-management-http.ts:42,54`) are
wildcard (`/api/topics/*`) restatements of the `:path` endpoints, with **byte-identical OpenAPI
descriptions**, wired to the same handlers (`ext/core/topics-http.ts:31`,
`ext/core/topic-management-http.ts:73,75`).

---

## 7. Typed-error surface

```sh
grep -rE 'extends Schema\.(Tagged)?Error' packages/*/src --include='*.ts'
grep -rE 'code:\s*Schema\.Literals\(\[' packages/*/src --include='*.ts'
grep -rn 'Record<' packages/*/src --include='*.ts'
```

| Measure | Count |
| --- | ---: |
| `Schema.TaggedError` / `Schema.Error` subclasses | **28** |
| — in `boot` | 19 |
| — in `server` | 6 |
| — in `storage` | 2 |
| — in `ui` | 1 |
| — in `protocol` | 0 |
| Distinct error codes across all `code: Schema.Literals([…])` unions | **142** |
| `KernelErrorCode` literals (`packages/protocol/src/error-code.ts`) | 47 |
| Distinct codes counting every `code: "…"` construction site too | **182** |
| Code → status/hint `Record<>` tables | **8** |
| Lines those 8 tables occupy | **598** |

### The 28 error classes

`boot`: `BootSchemaTooNew`, `BootIdentityUpgradePending` (`boot-schema.ts`), `PublicPagesUnavailable`,
`ReceiptError`, `RestoreBeforeImageError`, `EventStorageRejected`, `TrafficError`, `StorageRejected`,
`ChildError`, `FreezeTimeout`, `CutoverCleanupPending` (`cutover.ts`), `AppStoreLayoutError`,
`ArtifactRetentionRejected`, `EventError`, `RecoveryRejected`, `SourceRejected`, `SnapshotRejected`,
`AuthError`, `EditRejected`.
`server`: `PageRejected`, `ExtensionError`, `SubscriptionError`, `InvalidExtensionEntry`,
`KernelError`, `RolledBack`.
`storage`: `MigrationLedgerError`, `StoreError`. `ui`: `BoardError`.

### The 8 code → status → hint tables

| Table | Location | Lines |
| --- | --- | ---: |
| `policy` | `packages/protocol/src/errors.ts:5-238` | 234 |
| `policy` | `packages/boot/src/edit-failure.ts:42-157` | 116 |
| `policy` | `packages/boot/src/auth-http.ts:36-116` | 81 |
| `eventHints` | `packages/boot/src/event-http.ts:30-94` | 65 |
| `childErrorPolicy` | `packages/boot/src/child-error-policy.ts:19-66` | 48 |
| `eventStatus` | `packages/boot/src/event-http.ts:108-134` | 27 |
| `policy` | `packages/server/src/ext/subscriptions/response.ts:7-21` | 15 |
| `policy` | `packages/server/src/page-failure.ts:7-18` | 12 |
| **Total** | | **598** |

`packages/protocol/src/errors.ts` is 265 lines of which 234 (88%) is one table.

**41 of the 177 entries across these tables restate a code that another table already maps.**
The worst repeats: `query_invalid` and `idempotency_conflict` each appear in 4 tables;
`app_store_missing`, `app_store_identity_invalid`, `app_store_mismatch`, `cursor_ahead`,
`publication_pending`, `topic_move_recovery_required`, `storage_headroom`,
`storage_measurement_failed`, `backup_budget`, `invalid_storage_sample`, `unsafe_artifact_path`,
`handler_failed` and `scope_required` each appear in 3. This is the direct, measurable cost of
SPEC §12's "one record per module maps code to status and to a hint".

---

## 8. Suspected clusters, by filename

```sh
find packages/*/src -type f \( -name '*.ts' -o -name '*.tsx' \) \
  | grep -iE 'remote|transfer|migration|copy|keeper|guardian|owner|closure|recovery'
```

### Production source

| Keyword | Files | Lines |
| --- | ---: | ---: |
| recovery | 7 | 380 |
| remote | 5 | 419 |
| copy | 5 | 343 |
| keeper | 4 | 331 |
| migration | 4 | 298 |
| owner | 1 | 138 |
| transfer | 0 | 0 |
| guardian | 0 | 0 |
| closure | 0 | 0 |
| **Union (deduplicated)** | **25** | **1,825** |

The 25 files:

| Lines | File |
| ---: | --- |
| 178 | `packages/boot/src/sqlite-copy-process.ts` |
| 144 | `packages/boot/src/app-recovery.ts` |
| 138 | `packages/boot/src/linux-ownership.ts` |
| 122 | `packages/storage/src/migrations.ts` |
| 120 | `packages/boot/src/preparation-keeper.ts` |
| 111 | `packages/boot/src/child-keeper.ts` |
| 104 | `packages/storage/src/remote-driver.ts` |
| 98 | `packages/storage/src/remote-session.ts` |
| 87 | `packages/ui/src/recovery-controls.tsx` |
| 85 | `packages/storage/src/remote-inspector.ts` |
| 84 | `packages/boot/src/sqlite-copy-keeper.ts` |
| 80 | `packages/storage/src/remote-client.ts` |
| 64 | `packages/server/src/kernel/migrations.ts` |
| 61 | `packages/server/src/kernel/extension-migrations.ts` |
| 54 | `packages/ui/src/recovery-api.ts` |
| 52 | `packages/storage/src/remote-values.ts` |
| 51 | `packages/server/src/kernel/migration-state.ts` |
| 38 | `packages/ui/src/copy-prompt.tsx` |
| 35 | `packages/boot/src/recovery-intents.ts` |
| 30 | `packages/boot/src/recovery-page.ts` |
| 25 | `packages/boot/src/recovery-http.ts` |
| 23 | `packages/boot/src/sqlite-copy-worker.ts` |
| 20 | `packages/boot/src/sqlite-copy-configuration.ts` |
| 16 | `packages/boot/src/keeper-configuration.ts` |
| 5 | `packages/server/src/board-recovery.ts` |

### Tests

| Keyword | Files | Lines |
| --- | ---: | ---: |
| recovery | 8 | 1,089 |
| migration | 12 | 881 |
| remote | 7 | 728 |
| dialect | 4 | 345 |
| copy | 4 | 323 |
| keeper | 2 | 155 |
| owner | 1 | 99 |
| transfer / guardian / closure | 0 | 0 |
| **Union (deduplicated)** | **34** | **3,275** |

Note that `transfer`, `guardian` and `closure` yield **zero files** — the abandoned
`transfer-*.ts` PR really is gone from master. Its *dependencies*, however, are not (§9).

### Liveness-proof vocabulary, by occurrence

The "is the previous owner really dead" question, measured as identifier/comment occurrences in
`packages/*/src`:

| Concept | Occurrences | Files |
| --- | ---: | ---: |
| publication fence (`fence`, `published_through`) | 187 | 42 |
| writer epoch (`epoch`, `writer_epoch`) | 156 | 36 |
| intent journal (`intent`) | 89 | 16 |
| closure proof (`closure`, `closed_at`) | 80 | 23 |
| adoption record (`adopt*`) | 76 | 8 |
| owner inventory (`ownership`, `owner_inventory`) | 68 | 26 |
| kernel boot-id (`boot_id`, `bootId`) | 50 | 7 |
| copy keeper (`sqlite-copy`, `copyKeeper`) | 31 | 5 |
| keeper receipt (`keeperReceipt`, `keeper receipt`) | 4 | 3 |

Nine distinct named mechanisms. Job 4 of the charter, which contains all of them, is 5,275 lines.

---

## 9. The cross-engine residue

The row-by-row transfer tool is gone; the portability layer it justified is not.

| Artefact | Lines | Production importers |
| --- | ---: | ---: |
| `packages/storage/src/remote-driver.ts` | 104 | 0 (only `remote-client.ts`, `remote-inspector.ts`, tests) |
| `packages/storage/src/remote-session.ts` | 98 | **0** |
| `packages/storage/src/remote-inspector.ts` | 85 | **0** |
| `packages/storage/src/remote-client.ts` | 80 | **0** |
| `packages/storage/src/remote-values.ts` | 52 | 0 (only `remote-driver.ts`, tests) |
| **Subtotal** | **419** | **no module reachable from any entry point imports these** |
| `packages/storage/test/*remote*` + fixtures | 728 | — |
| `packages/server/test/fixtures/remote-dialect-semantics.ts` + its test | 127 | — |
| `.github/workflows/remote-sessions.yml` (spins up Postgres + MySQL each PR) | 46 | — |
| `scripts/remote-session-acceptance.sh` | 107 | — |
| `patches/@effect%2Fsql-mysql2@…patch` | 78 | — |
| `docs/database.md` (cross-engine compensations) | 1,421 | — |
| **Cluster total** | **2,926** | |

Plus the case split that reaches production:

`packages/storage/src/dialect.ts` is 118 lines and exports 12 helpers, every one of which is a
three-way `on(sql, { sqlite, pg, mysql })` branch (`dialect.ts:8-17`). **19 production files import
it** — 3 in boot (`events.ts`, `public-paths.ts`, `boot-write-lock.ts`) and 16 in server. Only the
`sqlite` branch is ever taken: no deployment path in the tree sets a Postgres or MySQL URL
(`grep -rn 'DATABASE_URL' packages/*/src scripts Dockerfile deployment` returns nothing), and
`packages/storage/src/store.ts:56` labels its own `RemoteStore` parser
"*Parse the future remote configuration without enabling it in SQLite-only callers*".
`withDatabase` and `asBoot` (`store.ts:78-110`, 33 lines) have **no caller outside
`packages/storage/test/store.test.ts`**. `parseDescriptor` (`store.ts:57-76`, 20 lines) is called
from production exactly once, at `store.ts:114`, inside the `store._tag !== "file"` branch of
`render` — and **no production code anywhere constructs a `RemoteStore`**
(`grep -rn 'RemoteStore|_tag: "postgres"|_tag: "mysql"' packages/*/src` matches only `store.ts`
itself), so that branch is statically reachable and dynamically dead. `.env.example:7-8` still
advertises `DATABASE_URL` and `BOOT_DATABASE_URL`; neither name appears anywhere in
`packages/*/src`, which reads `APP_STORE` / `APP_DATABASE`.

SPEC §12 still carries the sentence that authorised all of this — "*moving an existing board between
engines with chirp's own row-by-row transfer tool (no vendor dump moves between engines), which
writes a completion marker the startup check requires and stamps the source as transferred*" — even
though the PR that implemented it was closed.

---

## 10. Things that surprised me while counting

1. **The repository ships 152,654 lines of somebody else's source code.** `repos/effect` (1,538 `.ts`
   files) and `repos/pi-mono` (1,395) are committed snapshots, 5,687 tracked files, **5.9× the
   entire production codebase**. `repos/README.md` says they are read-only reference material. They
   are in every clone, every `git log`, and every recursive grep an agent runs.

2. **There is essentially no dead code by reachability.** Walking every relative import in
   `packages/*/src`, the only modules with zero importers are legitimate process entry points: boot's
   `index.ts`, `child-keeper.ts`, `preparation-keeper.ts`, `sqlite-copy-keeper.ts`,
   `sqlite-copy-worker.ts`, `deployment-layout.ts` (717 lines), and server's `main.ts`, `server.ts`,
   `sql-read-worker.ts` and the four dynamically-loaded extension entry points (667 lines). The
   bloat is duplication and over-generality, **not corpses** — with the single exception of
   `storage/src/remote-*` (§9), which is reachable only from tests.

3. **The safety net the owner ranks as guarantee 3 is the smallest thing in boot.** "A human can
   always get back in" is 123 lines across 4 files (0.9% of boot). "Is the previous owner dead" is
   ~40× that. Whatever else is true, effort is not distributed according to the stated priorities.

4. **`packages/protocol` is a shadow of `packages/server`.** 13 of its 20 files share a basename with
   a server file (`api.ts`, `conversation.ts`, `events.ts`, `events-http.ts`, `message-http.ts`,
   `messages.ts`, `profiles-http.ts`, `stream-http.ts`, `topic-management-http.ts`, `topic-move.ts`,
   `topic-operations.ts`, `topics.ts`, `topics-http.ts`), and
   13 of its 20 files are under 30 lines — including `topic-move.ts` at **2 lines**,
   `message-patch.ts` at 6, `request-validation.ts` at 9 and `topic-operations.ts` at 9. The package
   is only 761 lines but it doubles the file count and the import ceremony for the API surface.

5. **Boot has five files under 15 lines**: `human-agent.ts` (2), `decode-rows.ts` (5),
   `legacy-topic-moves.ts` (7), `source-reset-schema.ts` (7), `boot-write-lock.ts` (13). Together, 34
   lines in 5 modules with 5 import statements pointing at them. The "file per concept" habit named
   in the brief is still operating at the bottom of the size distribution, not just the top.

6. **98 references to `legacy` / `retired` / `deprecated` / `backward-compat` / `historical` across
   production source** in a product that has never shipped, serves one human on one machine, and can
   rewrite its own source over HTTP. `packages/server/src/ext/core/legacy-idempotency.ts` alone is
   197 lines. `packages/boot/src/legacy-topic-moves.ts:2` reads "*Presence alone requires the
   previous compatible image; never interpret or retire historical evidence*".

7. **The error-hint tables restate each other 41 times** (§7). Making a code without a mapping a
   compile error was meant to guarantee coverage; because there are 8 tables rather than 1, it
   guarantees 8 copies of the coverage.

8. **`@effect/sql-sqlite-bun` is declared as a runtime dependency by `boot`, `server`, `storage` and
   `server/runtime`, and imported by exactly one file** — `packages/storage/src/client.ts:1`. Boot's
   dependency count matches SPEC §7.1's "five" only because one of the five is unused directly.

9. **Test fixtures are a third of the test corpus and boot's fixtures exceed half of boot's own
   source.** `packages/boot/test/fixtures` is 69 files and 7,120 lines — 53% the size of the
   bootloader it exercises. Fixtures are where the subprocess launchers, VM reboot harnesses and
   keeper simulators live; they are load-bearing infrastructure counted as test code.

10. **895 lines of CI and shell exist to exercise two clusters.** `linux.yml` (78) +
    `linux-keeper-acceptance.sh` (267) for keepers and ownership; `reboot.yml` (56) +
    `reboot-guest.py` (244) + `reboot-vm.sh` (97) for kernel-lifetime proof;
    `remote-sessions.yml` (46) + `remote-session-acceptance.sh` (107) for engines nothing imports.

11. **`packages/server/runtime/package.json` is a second dependency manifest**, 41 lines and 23
    dependencies, staged onto the volume at boot. It re-declares the mysql2 patch. Any change to the
    real `package.json` must be mirrored here by hand or the staged runtime diverges silently.

12. **`docs/pr-1/` is 11,644 lines across 21 review documents** (~2.0 MB), against 25,762 lines of
    production source. `adversarial-findings.md` is 1,435 lines, `db-doc-review-a.md` is 1,579,
    `stack-review-round2.md` is 2,109. The review record is 45% the size of the thing reviewed —
    which is the accretion mechanism named in the brief, made visible.

---

## Appendix A — every boot source file

```sh
find packages/boot/src -type f -name '*.ts' -print0 | xargs -0 wc -l | sort -rn
```

| Lines | File | Leading doc comment (truncated) |
| ---: | --- | --- |
| 549 | `cutover.ts` | Serializes source proposals with process recovery |
| 483 | `auth.ts` | Effect Crypto has no constant-time comparison primitive |
| 463 | `proxy.ts` | Polls and the child protocol must not manufacture events |
| 459 | `database-restore.ts` | Select durable restore evidence before opening the app store |
| 452 | `edit-lock.ts` | 0: ordinary editor; 1: borrowed reset pin; 2: boot-owned reset pin |
| 448 | `supervisor.ts` | Supervisor owns process recovery; cutover shares its operation gate |
| 441 | `edit-http.ts` | Failed recovery permits committed-source diagnostics |
| 413 | `source-files.ts` | Let this filesystem decide aliasing |
| 403 | `events.ts` | Keep SQLite's indexed GLOB form; remote engines use a literal prefix |
| 377 | `auth-http.ts` | Browser navigations belong on the login page |
| 365 | `event-http.ts` | Constant-time comparison is not exposed by Effect |
| 346 | `index.ts` | Owns the listener and one scoped service graph |
| 272 | `route-discovery.ts` | Immutable descriptors live beside the handlers |
| 271 | `source-journal.ts` | One durable publication, transient recovery bytes separate |
| 258 | `boot-schema.ts` | Run once before constructing boot stores |
| 257 | `tokens.ts` | Hash-only credentials plus a short-lived encrypted receipt |
| 238 | `edit-failure.ts` | Pages publish immediately and need no lock and no reload |
| 213 | `child-process.ts` | One keeper-owned process lifetime, positive exit evidence |
| 211 | `enrollment.ts` | Enrollment and collection share the passkey admission mutex |
| 205 | `event-storage.ts` | Conservatively charges events plus shared free pages/WAL |
| 191 | `restore-before-image.ts` | Opaque SQLite bytes only |
| 191 | `artifact-retention.ts` | Call under supervisor.operationGate |
| 189 | `source-tree-publication.ts` | Atomic empty-directory removal is not provided by Effect |
| 189 | `app-store-identity.ts` | Boot's durable handshake is separate from the app transaction |
| 184 | `backup-http.ts` | Lists retained catalog metadata for a live human session |
| 178 | `sqlite-copy-process.ts` | One boot-owned SQLite copy intent |
| 178 | `source-revert.ts` | Called inside cutover's acceptance transaction |
| 154 | `snapshots.ts` | Shared by initial seeding and generation snapshots |
| 153 | `token-mint.ts` | One signed transaction owns issuance and a receipt |
| 151 | `passkey-management.ts` | Composes with Auth's single mutex and boot transaction |
| 146 | `enrollment-http.ts` | — |
| 146 | `database-restore-auth.ts` | Resolve catalog metadata only |
| 144 | `db-ops.ts` | SQLite online copies include committed WAL pages |
| 144 | `app-recovery.ts` | Shared startup evidence boundary |
| 140 | `database-backup.ts` | Shares the writer drain boundary |
| 138 | `linux-ownership.ts` | Fixed image identities; only immutable sudo keepers call as root |
| 137 | `source-io.ts` | Platform IO bound to one editable data root |
| 134 | `generation-preparation.ts` | Runs fixed install/build commands before rehearsal |
| 127 | `generations.ts` | Durable generation history |
| 126 | `settings.ts` | Authorization, policy, audit event and replay receipt in one commit |
| 123 | `public-event-http.ts` | One bounded delivery engine for recovery + child queries |
| 122 | `application.ts` | Local development dependency link |
| 120 | `preparation-keeper.ts` | This immutable entry only runs the two preparation commands |
| 118 | `app-store-layout.ts` | Call only after prior child ownership is positively closed |
| 116 | `settings-schema.ts` | Historical signed requests retain their canonical shape |
| 111 | `child-keeper.ts` | Immutable owner of one editable app process group |
| 100 | `storage-volume.ts` | Only fixed numeric stat output or C-locale POSIX df |
| 97 | `auth-page.ts` | Immutable boot UI |
| 95 | `preparation-process.ts` | Fixed subprocess commands |
| 91 | `prepared-tree.ts` | Copies installed package links |
| 90 | `database-restore-http.ts` | Human-only database rollback |
| 84 | `sqlite-copy-keeper.ts` | Remains responsive while the worker blocks in SQLite |
| 84 | `source-schema.ts` | Directory identity is separate from absent file images |
| 78 | `restore-generation.ts` | Prepare selected source against its exact backup |
| 78 | `refresh-receipt.ts` | Effect Crypto exposes no HKDF or authenticated encryption |
| 75 | `traffic.ts` | Admission is atomic with freeze |
| 75 | `request-events.ts` | Boot-scoped diagnostic writer |
| 75 | `database-restore-schema.ts` | — |
| 68 | `child-attempts.ts` | Durable process ownership evidence |
| 67 | `refresh-schema.ts` | Canonical persisted credential row |
| 66 | `child-error-policy.ts` | Exhaustive child failures shared by boot HTTP boundaries |
| 64 | `storage-headroom.ts` | Standalone filesystem tools retain the minimum reserve |
| 61 | `public-paths.ts` | Apply only with the first durable event append |
| 57 | `enrollment-page.ts` | — |
| 56 | `passkey-management-schema.ts` | Fixed-order arrays for cryptographic bindings |
| 53 | `token-mint-schema.ts` | — |
| 52 | `log-events.ts` | The synchronous logger only offers into a scoped dropping queue |
| 50 | `backup-inventory.ts` | Catalog metadata only |
| 50 | `auth-primitives.ts` | Capture the owning service's Crypto implementation |
| 50 | `account-queries.ts` | Human account metadata readable without an app |
| 49 | `passkey-management-http.ts` | — |
| 48 | `rehearsal-report.ts` | Historical snapshots did not report suppression |
| 44 | `public-pages.ts` | Anonymous admission reads only boot-owned published grants |
| 43 | `lock-break.ts` | Fresh proof, live session, observed lock, one boot transaction |
| 43 | `generation-source.ts` | Only new source-preserving snapshots can be undone |
| 39 | `enrollment-schema.ts` | — |
| 37 | `token-http.ts` | These exact routes survive child failure |
| 37 | `boot-route.ts` | Capture the request without introducing a scope |
| 35 | `recovery-intents.ts` | One recovery operation owns the stores |
| 33 | `restart-http.ts` | Signal boot only after the response reaches the adapter |
| 33 | `deployment-layout.ts` | Root image entrypoint only |
| 33 | `boot-http.ts` | Concrete listener dependencies |
| 31 | `boot-schema-shape.ts` | Validate boot's required columns |
| 30 | `seed-source.ts` | Capture image-owned editable source once |
| 30 | `recovery-page.ts` | Immutable recovery needs no app process |
| 28 | `token-mint-http.ts` | — |
| 26 | `settings-http.ts` | — |
| 25 | `recovery-http.ts` | Human recovery stays reachable without the app |
| 25 | `kernel-boot.ts` | Only the kernel's canonical random UUID is evidence |
| 25 | `backup-metadata.ts` | A null fence identifies legacy backups |
| 23 | `sqlite-copy-worker.ts` | Never loads editable code or spawns descendants |
| 23 | `account-http.ts` | Human-only account metadata |
| 20 | `sqlite-copy-configuration.ts` | Fixed immutable copy operation |
| 18 | `store-identity-diagnostics.ts` | Malformed store content must not become a path |
| 18 | `request-bytes.ts` | Count streamed bytes before retaining a chunk |
| 16 | `keeper-configuration.ts` | Immutable keeper wire contracts |
| 13 | `boot-write-lock.ts` | Take before boot read/compute/write work |
| 7 | `source-reset-schema.ts` | Reset never accepts source paths or deletion options |
| 7 | `legacy-topic-moves.ts` | Presence alone requires the previous compatible image |
| 5 | `decode-rows.ts` | Decode SQL rows in the caller's existing effect and scope |
| 2 | `human-agent.ts` | Immutable single-human attribution |

## Appendix B — commands

```sh
# worktree
git -C /Users/cryogenicplanet/general/comms worktree add --detach <wt> origin/master

# production lines/files per package
find packages/<p>/src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' \) \
  ! -name '*.test.ts' ! -name '*.test.tsx' ! -name '*.spec.ts' -print0 | xargs -0 wc -l

# test lines/files per package
find packages/<p>/test -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 wc -l

# largest files
find packages/*/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 wc -l | grep -v ' total$' | sort -rn | head -20

# dependency usage
grep -rlE 'from "<dep>("|/)' packages/<p>/src --include='*.ts' | wc -l

# error surface
grep -rE 'extends Schema\.(Tagged)?Error' packages/*/src --include='*.ts'
grep -rE 'code:\s*Schema\.Literals\(\[' packages/*/src --include='*.ts'
grep -rn 'Record<' packages/*/src --include='*.ts'

# suspected clusters
find packages/*/src -type f -name '*.ts' \
  | grep -iE 'remote|transfer|migration|copy|keeper|guardian|owner|closure|recovery'

# vendored reference source
git ls-files repos | wc -l
git ls-files repos -z | xargs -0 wc -l | tail -1
```
