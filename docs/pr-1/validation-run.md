# Validation run for PR #1

Run by an Opus agent on the working tree at HEAD `4885295` (two commits past the review head `b9d6f28`). Commands, results and the findings the run surfaced.

## Validation run (exact commands, in `/Users/cryogenicplanet/general/comms`)

| Command | Result | Duration |
|---|---|---|
| `ls node_modules/.bin \| head` | deps installed (`vitest`, `oxlint`, `oxfmt`, `tsc`, `effect-tsgo`) — no `bun install` needed | — |
| `bun run check` | **PASS** — `oxfmt --check` clean on 314 files; `oxlint --type-aware` clean; `tsc --noEmit` + per-package `check` all exit 0; `check:invariants` → "Workspace import boundaries passed." | 2.4s wall |
| `bun run test` | **FAIL** — `Test Files 1 failed \| 84 passed (85)`, `Tests 1 failed \| 297 passed (298)` | 118.5s |
| `git diff --stat master...HEAD -- . ':!bun.lock' ':!repos'` | 303 files changed, 31593 insertions(+), 227 deletions(-) | — |
| `git status --short` | only `?? docs/pr-1/` (pre-existing, not written by the checks; nothing reformatted) | — |

Counts do **not** match the PR's claim of "289 tests across 82 files pass": actual is 298 tests / 85 files, with 1 failing. Also **HEAD is `4885295`, not `b9d6f28`** — two commits newer (`4246e30` "Expose human backup inventory and enforce page archives", `4885295` "Keep child lifecycle controls behind the boot boundary").

Failing test:
```
packages/server/test/public-pages.test.ts > opens only exact opted-in page topics and filters anonymous directory listings
AssertionError: expected 503 to be 200 // Object.is equality
 ❯ packages/server/test/public-pages.test.ts:22:26
```
I re-ran `bunx vitest run packages/server/test/public-pages.test.ts` three times: **pass, pass, fail**. It is a genuine nondeterministic failure, not environmental — root cause in finding 1.

`scripts/check-invariants.ts` (113 lines): it parses every `.ts`/`.tsx` under `packages/` with the TypeScript AST and rejects four things — relative imports that escape the owning package, `@comms/*` imports outside the single allowed chain (`ui` launcher → `server` → `boot`, with `ui/src` forbidden from importing `server` at all), any import of the vendored `repos/`, and inline `import("…")` type nodes. These are meaningful and cheap: they are the only mechanical guard that the app package cannot reach into the immutable bootloader's internals, which is the trust boundary SPEC §7.9 depends on, and they encode the one-directional dependency the build actually relies on. They do not cover the other AGENTS.md rules (no barrels, file size, no module-level mutable state), so the name oversells the scope.

---

## Findings

### 1. blocker — anonymous page reads 503 whenever any publication is in flight, with no retry (the failing test)
`packages/boot/src/public-pages.ts:127`
```ts
// No app reservation can begin or publish while this channel gate is held.
if ((yield* events.state).pending_id !== null) return yield* new PublicPagesUnavailable({});
```
The sibling write path deliberately *waits* for the same condition — `withWrite` loops with a 1s deadline and a `Effect.sleep("10 millis")` backoff (lines 54-97, comment at 95: "Allow the pending app outbox to append before checking again"). The read path has no such loop: it fails immediately, and `proxy.ts:143` turns that into `503 boot_unavailable`.

Failure scenario (exactly the flake): the test posts four messages and then fetches `/p/guide/readme.md` anonymously. If the last message's reserved batch has not yet been relayed to `/_boot/events/append`, `seq.pending_id` is still set and the public page returns 503 instead of 200. In production this means every anonymous reader of a public page gets an intermittent 503 proportional to write traffic on the board — a publicly-visible page that flickers offline whenever an agent posts. The fix is the loop the write path already has.

### 2. blocker — all anonymous page reads serialize on the same single-permit semaphore as `cutover.reload`, so public pages are down for the whole duration of every edit
`packages/boot/src/public-pages.ts:100-103` and `:174`
```ts
const check = (pathname: string) =>
    operationGate
        .withPermit(channelGate.withPermit(Effect.gen(function* () { … })))
        .pipe(Effect.timeout("1 second"), Effect.catchCause(() => Effect.fail(new PublicPagesUnavailable({}))))
```
`packages/boot/src/index.ts:81` passes `supervisor.operationGate`, and `supervisor.ts:47` makes it `Semaphore.make(1)`. `packages/boot/src/cutover.ts:96` holds that *same* permit for the entire `reload`: rehearsal with a 30-second health deadline (`cutover.ts:138-139`), a full `VACUUM INTO` clone (`:132`), the freeze, and the 10s cutover.

Failure scenario: an agent `PUT`s one file. For the next ~5-30s every uncredentialed `GET /p/<topic>/<file>` blocks on the permit, trips the 1-second `Effect.timeout`, and returns `503`. SPEC §7.7 step 4 promises the opposite — "Reads keep flowing to the live child. SSE and `/_boot/*` are unaffected" — and §0 promises "The public socket never closes." Public page reads need their own concurrency, or to read a cached policy snapshot, not the cutover mutex. (Secondary cost: permit-1 means anonymous page traffic is globally serialized even with no edit running, each request doing several `realPath`/`stat` calls plus opening a fresh SQLite connection at `:135-140`.)

### 3. blocker — the 10-second freeze budget wraps backup + candidate health, contradicting §7.7, and `freeze_timeout` does not exist
`packages/boot/src/cutover.ts:160-209`. One `freeze` effect contains steps 4, 5, 6 and 7 of §7.7 — drain (`:164`), the pre-flip `VACUUM INTO` of the whole app store (`:171`), the cutover row insert (`:187`), the candidate `go` and its 5-second health probe (`:195-196`), and acceptance (`:201`) — and then:
```ts
const freezeMs = yield* freeze.pipe(Effect.timeout("10 seconds"));
```
SPEC §7.7 scopes the 10s budget to the *drain* only ("Wait for both boot admissions and the child's in-flight mutations to drain … within the 10s freeze budget") and puts the backup in step 5, after it. It also mandates a specific outcome: "If the freeze budget is exceeded at step 4 … the cutover is abandoned before the backup, queued writes are released to the live child, and the write response says `freeze_timeout`." `grep -rn "freeze_timeout" packages/` returns **nothing** — only SPEC.md:586.

Failure scenario: `app-backup.ts:22` implements `clone` as `VACUUM INTO`, a full rewrite of the database. Once the app store passes a few hundred MB, `VACUUM INTO` plus the 5s health probe cannot fit in 10 seconds, so *every* edit times out, takes the `persisted` restore branch (`cutover.ts:261-268`), and reports a generic timeout string instead of `freeze_timeout`. The hot-reload loop — the single core guarantee of the project — degrades to unusable as a function of data volume, and the agent gets no actionable error code. The drain needs its own budget, the backup needs to be outside it, and a distinct error code.

### 4. major — no disk budget or pruning at all, on a fixed volume, while every edit permanently adds a full snapshot and a full database copy
SPEC §7.5 "**Disk is budgeted.**" specifies backups capped at 20% of the volume with oldest-hourly-first eviction, snapshots pruned to the last five good generations plus live, an events 10% cap, and "The bootloader refuses any write that would leave less than 5% headroom, so a delete always has room to record itself." `grep -rn "headroom\|budget\|statfs" packages/boot/src` returns nothing. `storage-maintenance.ts` (44 lines) only schedules an hourly backup and a weekly drill — no eviction. `event-retention.ts:36-38` prunes by age only, no byte cap. `snapshots.ts:114` even comments "later retention can remove the reservation" pointing at code that does not exist.

Failure scenario: the deploy target is one Docker volume. Each cutover writes a generation snapshot of the whole `app` tree (`cutover.ts:126`) plus a `pre-flip` `VACUUM INTO` copy of the whole app store (`:171`), and an hourly backup accumulates forever. The volume fills, `VACUUM INTO` then fails inside the freeze, and with no headroom check the failure mode is that **no edit and no revert can complete** — the unrecoverable state the design is built to prevent. The author does disclose this in `docs/build-plan.md:16,19` ("physical byte budgets", "snapshot/backup/artifact pruning, disk headroom/budgets" listed as not done), which is why this is major rather than blocker, but SPEC §11 puts "backups within budget" in phase 0b, which this PR otherwise claims.

### 5. major — the `DbOps` seam that `docs/tech.md` says isolates the backend does not exist; SQLite is hard-wired into the immutable core
`docs/tech.md:121`: "What changes per backend is isolated in one service, `DbOps`, with three implementations", with a table mapping `snapshot()`, `cloneForRehearsal()`, `restore(backup)` to SQLite/Postgres/MySQL. `grep -rn "DbOps\|dbOps" packages/` returns **nothing**. `@effect/sql-pg` and `@effect/sql-mysql2` are not dependencies of either package.

Instead SQLite is inlined at the call sites, including in boot: `app-backup.ts:22` `VACUUM INTO ${destination}`; `app-backup.ts:49-59` `restore` is `copyFile` + deleting `-wal`/`-shm` + `rename` of a file path; `public-pages.ts:42-47` and `:135-141` construct `SqliteClient.layer({ filename: path.join(directory, "comms.db") })` inline, twice; `public-pages.ts:64,66` query `sqlite_master` and `PRAGMA user_version`; `events.ts:185-191` and `event-retention.ts:37` filter with `json_extract`. Six files import `SqliteClient` directly, thirteen use SQLite-only SQL.

Concrete cost: "Postgres/MySQL must be an option for both stores" is a fixed owner requirement, and delivering it now means editing `app-backup.ts`, `public-pages.ts`, `app-recovery.ts`, `index.ts`, `events.ts` and `event-retention.ts` — i.e. rewriting the bootloader, which is exactly the code that must be "very hard to break." Either introduce the one-service seam the doc already designed, or correct `docs/tech.md` to say SQLite-only so the gap is not invisible.

### 6. major — `Events.query` reimplements every filter twice, in SQL and then in TypeScript, in the hottest query in the immutable core
`packages/boot/src/events.ts:184-214`. The SQL `WHERE` clause (lines 185-191) filters on topic subtree, `requestActor`, `excludeMessageInstance`, `agent`, `instance`, `level`, and glob `types` with a `json_each` wildcard match. Lines 196-214 then re-apply topic-prefix, agent, instance, level, and wildcard-type filters in TypeScript over the same rows.

Concrete cost: two copies of one predicate that must stay semantically identical (the wildcard rule is spelled `substr(value,-1)='*'` in SQL and `type.endsWith("*")` in TS; the subtree rule is `substr(json_extract(…),1,length(?)+1)=?||'/'` in SQL and `startsWith(\`${topic}/\`)` in TS). If they ever diverge the TS pass silently discards rows the SQL matched, and because `cursor` is computed as `items.at(-1)?.seq ?? since` (line 215) a permanently-discarded row leaves the cursor un-advanced — a long-poll client on `/api/events` would spin at the same `since` forever with an empty result set. This is the single most-depended-on read path in boot (`seq` is "one number space" per §2) and it should have one filter, in SQL.

### 7. minor — `cutover.ts` dodges two of its own shadowing/narrowing problems with aliases and IIFEs, in the file that must be hardest to break
`packages/boot/src/cutover.ts:296`: `const optionsSource = options;` is declared at the *end* of the factory but consumed at `:118`, `:119` and `:167` — it exists only because `reload`'s own parameter at `:94` is also named `options` and shadows the outer `ApplicationSource`. It happens to work (closure capture before `reload` runs), but a reader of `:119` has to scan past the entire 200-line `reload` body to find out which `options` is meant. Rename `reload`'s parameter instead.

`:225` and `:232`:
```ts
const failedGeneration = ((): Generation | null => generation)();
const failedCandidate = ((): ActiveChild | null => candidate)();
```
Two IIFEs whose only purpose is to launder TypeScript's narrowing of the `let candidate` / `let generation` declared at `:105-106`. Both also violate the repo's own "`const` by default / no mutable state" rule. Restructuring `perform` to return its candidate/generation in its `Exit` value would remove the `let`s and both IIFEs.

### 8. note — `packages/server/src/kernel/ext.ts` is 442 lines
AGENTS.md sets "one concept per file ~400 lines max". Only one non-test source file exceeds it (`ext.ts`, 442; the next largest is `messages.ts` at 333), so this is not systematic — but since the extension loader is the seam agents are expected to read before writing `app/ext/*.ts`, it is the file where the limit matters most.
