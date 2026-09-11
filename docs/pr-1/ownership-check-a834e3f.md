# Ownership check: `docs/boot-ownership-audit.md` and the post-5d96c1d commits

Read-only verification pass. No tracked file was edited.

**Commits.** The task named `a834e3f`. By the time this pass started the branch was at `66b1a9c` ("Record boot ownership audit and confirmed recovery boundaries"), which commits `docs/boot-ownership-audit.md` — it is no longer untracked. The branch kept moving during the pass, through `c433bcb`, `dd3c6e7`, `ba5866b`, `2ee17ac` to `39e0bd0`. Part A is judged at `66b1a9c` (boot identical to `a834e3f`); Part B at `2ee17ac` unless stated. Four commits landed after `66b1a9c` that implement the audit's own removals, and they matter to the verdict; they are findings A-12 to A-14.

**`bun run check`** passes at `39e0bd0` in about 90 seconds: `tsc --noEmit` clean across all four packages, `scripts/check-invariants.ts` reports "Workspace import boundaries passed". Output is oxlint warnings only (`prefer-schema-over-json`, `global-console`), almost all in test fixtures. The full suite was not run.

---

## Verdict

The ownership audit is a good essay and a poor inventory. Its boundary paragraph is the right test and its eight-row removal table is defensible. But it names 15 of 94 boot files (16%), and the responsibilities it proposes to remove total roughly 1,050 lines against a 5,080-line gap to the review's 7,250 target. Even executed in full it does not finish the cut item 27 asked for, and it does not say so.

Its more consequential property is that it is being executed as if it were an owner decision. Four commits after the audit was recorded removed `GET /_boot/metrics`, `POST /_boot/fs/edit`, boot's `/api/events` and child trace aggregation from boot. Three of those reverse things recorded as confirmed in `pr-comments.md`, and none of them has an entry in `pr-comments.md` or an edit to `SPEC.md`. The repository now contradicts itself about what boot serves, and `init.md` tells every new agent something that is no longer true.

On the second-pass defects: items 25, 26, 27, 29 and 31 are genuinely fixed. Item 31 is 17 of 18. Items 28 and 30 are partly fixed and both still reach the outcome the review named. No confirmed decision from items 1 to 24 was regressed by an ordinary defect fix; the only reversals are the four deliberate ones above, plus one new 282-line boot module.

Boot is **12,265 lines in 93 files** at `39e0bd0` (12,330 in 94 at `a834e3f`/`66b1a9c`), against a 7,250 target. It has not shrunk: `git diff --stat 5d96c1d..2ee17ac -- packages/boot/src` is 55 files changed, +916/−792.

---

## Top items for the owner, ranked

1. **Decide whether `docs/boot-ownership-audit.md` supersedes `pr-comments.md` items 8, 21 and 22, and write that down.** Codex is implementing the audit as authorization. Until the ledger says so, `SPEC.md` §6, `pr-comments.md` and the shipped code disagree about four routes.
2. **`/api/events` moved into the hot-reloadable child** (`2ee17ac`). Item 21's own accepted-weakening list says "an app swap drops `/api/stream` (long-poll does not)". It now drops the long-poll too: `packages/server/src/events-http.ts:46` races the wait against `ctx.drained`. `SPEC.md:289` still says "Served from `boot.db`, so a swap never interrupts it." `pages/init.md:33` and `pages/docs/recipes.md:48` still tell agents to use it across swaps.
3. **`packages/boot/src/legacy-topic-moves.ts`, 282 new immutable lines**, replacing the 228 lines item 27 said to delete. It is migration code for tables that exist only on this unmerged branch, and it contains a recursive tree walk with per-file SHA-256 at `:88-125` and a page-subtree `fs.rename` at `:266` — the two things item 21 step two and item 24(4) said to remove from boot.
4. **Item 28 is not closed.** The mutation-gate release is still conditional on the failure being a `ChildError` (`packages/boot/src/supervisor.ts:272`). A missed 5-second health deadline fails with a `TimeoutError`, the guard returns early, and the gate stays frozen for the life of the process — on the unattended hourly backup path. This was equally true under commit `4147a1a`; the later `75fa8f1` refactor is not the cause.
5. **Item 30 leaves no unconditional way in.** `/_boot/lock` and `/_boot/revert` become writable in the Failed phase only if a re-run of recovery succeeds (`packages/boot/src/edit-http.ts:54-64`). A persistently failing recovery still has no write path.
6. **The size claim in `docs/codex-scratchpad.md:128` is wrong and stale.** It says 9,361 lines in 78 files. No exclusion rule reproduces that number: at `51eef7a`, the commit that wrote the line, boot was 10,029 in 81 files (9,832 non-blank; 9,874 excluding the two standalone keeper entry points). It is understated by roughly 670 lines even at its own commit, and by 2,904 lines and 15 files against `39e0bd0`.

---

## PART A — what the ownership audit misses

### A-1. Coverage: 15 of 94 files named

Files the audit names anywhere: `index.ts`, `route-discovery.ts`, `request-events.ts`, `metrics.ts`, `log-events.ts`, `source-files.ts`, `edit-http.ts`, `application.ts`, `event-retention.ts`, `event-storage.ts`, `events.ts`, `token-mint.ts`, `enrollment.ts`, `account-queries.ts`, `proxy.ts`. The other 79 files (about 9,800 lines) are covered only by category, if at all.

Most of that is fine — the retained categories map cleanly onto auth, cutover, journal, restore and keeper files. The modules below are the ones where the mapping is not clean, or where the audit's silence hides something.

| File | Lines | Audit coverage | My verdict |
| --- | --- | --- | --- |
| `legacy-topic-moves.ts` | 282 | **Not mentioned at all.** The audit discusses `events.ts`'s topic-move interpretation but never this file. | **DELETE.** Pure compatibility for `topic_moves`/`topic_page_moves`, tables that only ever existed on this unmerged branch. It is live, not dead: `index.ts:130` and `:140` call it on every recovery pass. It re-adds the atomic page-subtree rename (`:266`) and a whole-tree SHA-256 hasher (`:88-125`) that item 21 removed. If any real deployment needs it, it is a one-time script, not immutable boot code. |
| `route-discovery.ts` | 279 | Named in Evidence as "immutable public surface inventory" and retained under "Immutable recovery manifest/help". | **KEEP ~60, the rest is prose.** The load-bearing part is the descriptor table's method/path/access triples. The bulk is English route descriptions — the `/_boot/settings` POST entry alone is a 60-word paragraph. It is also self-inconsistent with the audit: at `66b1a9c` it advertises `/_boot/metrics` (`:39`) and `POST /_boot/fs/edit`, both of which the audit proposes to remove and `dd3c6e7`/`ba5866b` then removed. Immutable prose about mutable routes is the wrong shape. |
| `edit-failure.ts` | 203 | Not mentioned. | **KEEP.** This is item 6's fix applied to the edit surface: exhaustive typed status/hint tables over nine error unions. Load-bearing for dead-app repair; it is what makes a failed edit legible. Note it imports `BootMetrics` at `:15`, so `dd3c6e7` had to touch it. |
| `artifact-retention.ts` | 188 | Covered by "Physical headroom and protected-artifact reclamation". | **KEEP**, but the audit's justification is weaker than it reads. It defends this as a dead-app necessity ("a full store must not prevent recovery"). About half the file is the 20% backup cap and five-generation prune, which is the §7.5 budget the owner explicitly asked boot to enforce (item 21: "the 5% headroom refusal and event retention are the two policies boot must enforce when the app is dead"). That is a better argument than the one given. |
| `storage-volume.ts` | 100 | Not mentioned. | **KEEP.** `boot-audit.md:148` said "KEEP ~55, the free-space probe". It is now 100 lines because item 29's fix added the 1-second sampler and the 5-second staleness bound (`:97-99`). That growth is the review's own ask, correctly spent. |
| `generation-preparation.ts` + `preparation-process.ts` + `preparation-keeper.ts` + `prepared-tree.ts` | 440 | Not mentioned. | **The audit's largest omission by line count.** `boot-audit.md:222` calls this "the single most un-bootloader-like thing left in the tree" and lists deleting it as a §3C option the owner has not taken. An ownership audit that skips a package manager running inside the bootloader has skipped the hardest case. Item 27(4)'s specific complaint is fixed: the bun cache is now persistent at `/data/cache/bun` (`preparation-keeper.ts:19-23`, `BUN_INSTALL_CACHE_DIR` at `:62`, directory created with mode 0700 by `deployment-layout.ts`). The 60-second install deadline at `preparation-process.ts:69` stands, which is now reasonable with a warm cache. |
| `linux-ownership.ts` | 129 | Not mentioned. | **KEEP.** Fixed `setpriv` uid/gid/capability vectors for the child and build identities. SPEC §12 ("Exact file ownership with `setpriv`") and §7.9 depend on it, and it is root-only code no extension may touch. Genuinely immutable. |
| `deployment-layout.ts` | 33 | Not mentioned. | **KEEP, but it is miscounted.** It is a separate image entrypoint (`package.json` builds it as its own bundle) and never loads into the serving boot process. It inflates the "boot production" figure without being boot runtime. |
| `human-agent.ts` | 2 | Referenced implicitly by "defined once in immutable boot code". | **KEEP.** This is the fix for item 27(3). See A-6. |
| `account-http.ts` | 23 | Covered by "Historical enrollment catalog". | Agrees with the audit. Two GET routes over two plain reads in `account-queries.ts`. The audit's "there is no roster subsystem left to move" is accurate. |
| `decode-rows.ts` | 5 | Named in the Evidence list indirectly. | **KEEP.** One of item 21's 462 merge lines, correctly landed. |
| `restart-http.ts` | 33 | Not mentioned. | **KEEP.** This is one of the three missing SPEC rows item 21 asked for, now implemented with Origin check, fresh assertion and a finalizer-ordered restart signal. |
| `metrics.ts` | 33 | In the remove table. | Agree it does not belong in boot — but see A-13, because item 21 explicitly listed it as a spec row to **implement**. |
| `log-events.ts` | 52 | In the remove table ("Consider removing"). | Agree. Nothing consumes these rows as recovery evidence. |
| `request-events.ts` | 103 | In the remove table, narrowed to "keep boot's bounded request record, remove child annotation aggregation". | Agree with the narrowing. Worth flagging: `boot-audit.md:194` sized this at 65 lines and the owner kept it as an explicit exception ("One exception, kept: `request-events.ts`, 65 lines"). It is now 103. The owner approved 65 lines of forensics, not 103. |
| `event-retention.ts` | 57 | In the remove table. | **Disagree.** See A-9 — the owner already decided this stays. |
| `token-mint.ts` (+ schema, + http) | 234 | In the remove table. | Reasonable ownership argument, but it reverses a decision. `boot-audit.md:224` offered exactly this deletion (−271) as a §3C option and said it "removes things the spec promises over HTTP"; the owner did not take it. Needs an explicit call. |
| `application.ts` `seedPages` | 122 file | In the remove table. | Agree. `application.ts:48` gates seeding on a `pages_seeded` settings row and `:51-53` already refuses to let seeding veto recovery from a good snapshot, so the move is safe and the existing evidence contract is preserved as the audit says. |

### A-2. "There is no roster subsystem left" — TRUE

`packages/boot/src/agent-roster.ts` does not exist. `grep -rn '_boot/agents' packages/boot/src packages/server/src` returns nothing. The surviving listings are two plain SQL reads in `account-queries.ts:32` and `:37`, served by `account-http.ts:17`. The claim is accurate.

### A-3. "Unused selector-only undo coordinator removed" — TRUE

Commit `e96dec5` "Remove obsolete undo selector retry coordinator".

### A-4. "Live discovery composition moved to editable server" — TRUE, with a new coupling the audit does not mention

Commit `a834e3f` deleted boot's `discoveryResponse` rewriting. Boot now serves the immutable manifest standalone (`proxy.ts:468`). But the direction inverted rather than disappeared: the **app** now fetches boot's manifest at `packages/server/src/discovery.ts:17` under a 1500 ms budget, failing `boot_unavailable` at `:18`/`:29`. That is a new app-to-boot call of exactly the class item 21's second CI invariant was written about. The audit presents this as a pure removal.

### A-5. "HTTP PUT currently does not pass the content token" — TRUE at `a834e3f`, fixed at `ba5866b`

At `66b1a9c`, `source-files.ts:247` takes `baseVersion` and `:250-251` raises `stale_base`, and `edit-http.ts` has no `baseVersion`/`If-Match` plumbing at all — grep for `anchor|contentToken|ifMatch|expected` in `edit-http.ts` returns nothing. The audit's reading is correct. Commit `ba5866b` then implemented the conditional raw write (`If-Match: "<sha256>"` / `If-None-Match: *`) and deleted the anchored route. See A-14.

### A-6. Hardcoded `"rahul"` — the audit is right, item 27(3) is FIXED

`grep -rni 'rahul' packages/boot/src --include='*.ts'` excluding tests returns exactly one line: `packages/boot/src/human-agent.ts:2`, `export const humanAgent = "rahul";`. Nine files import it (`token-mint-schema.ts`, `enrollment.ts`, `settings.ts`, `lock-break.ts`, `auth-http.ts`, `tokens.ts`, `database-restore.ts`, `token-mint.ts`). The second pass counted ten literals across nine files; that is now one literal in one file. The audit's "defined once in immutable boot code" is accurate.

### A-7. "`events.ts:153` explicit topic-move interpretation" — TRUE

`packages/boot/src/events.ts:153` is `if (event.type === "topic.moved") {`, followed by payload decode, six path-shape validations, the historical `UPDATE events SET topic=...` rewrite at `:166-167`, and `movePublicPaths` at `:168`. The audit's characterization is exact, and its argument that the grant update protects anonymous admission while the historical rewrite is product semantics is correct.

### A-8. The SPEC §6.1 / §12 contradiction on retention — REAL in the text, but the owner already resolved it

Both passages exist:

- `SPEC.md:336` (§6.1): "Retention: `http.request` kept 7 days, everything else 30, **pruned hourly by the bootloader**, plus a byte budget (§7.5). All are `settings`, changeable from `/@rahul`."
- `SPEC.md:696` (§12): "Policies, listings, caches, schedules, drills, **retention rules** and rendering decisions belong to the app or extensions."

So the audit's reading is textually fair. But §12's own enumeration of what leaves boot does not include event retention, and `pr-comments.md` item 21 makes the carve-out explicit: "implement the §7.5 budget itself: **the 5% headroom refusal and event retention are the two policies boot must enforce when the app is dead**". The audit cites the generic §12 sentence and does not mention the specific override. That is the single most misleading move in the document, because event retention is the one scheduled policy the owner named as boot's.

`index.ts:85` forks `retainEvents` today. My verdict: keep it, and fix §12's sentence to carve out the two §7.5 policies rather than deleting the mechanism.

### A-9. The retain list against the owner's rule

Genuinely load-bearing for dead-app repair — no argument:

- Auth, passkeys, enrollment, refresh, revocation, action proofs (SPEC §4.3 puts the floor in boot by construction).
- Credential/header stripping and public admission.
- Keeper receipts, attempt identities, epochs, ownership closure.
- Freeze/drain, candidate health, acceptance, fallback.
- Source lock, staging, filesystem validation, publication journal.
- Consistent backup, closure-gated restore, backup selection metadata.
- Sequence reservation, append/replay, publication fence, abort reconciliation.
- Physical headroom and protected-artifact reclamation.

Retained on a weaker footing:

- **"Source version inspection, safe revert and retained generations."** The audit anchors this on "the owner explicitly retained" — a clarification recorded only in the audit's own preamble (`docs/boot-ownership-audit.md:5`), not in `pr-comments.md`. It may well be what the owner said; it is not in the ledger. `source-revert.ts` (243) plus `source-journal.ts` (271) plus `source-tree-publication.ts` (189) is 703 lines resting on it.
- **"Minimal bounded boot request/failure diagnostics."** Correct in principle, but the owner approved 65 lines and the file is 103.
- **"Immutable recovery manifest/help."** Correct in principle, wrong in size — 279 lines, mostly English, describing routes that are being deleted.
- **"Topic moves inside event append"** (in the not-intrinsic section). The audit is right that the `public_paths` grant update must stay in the append transaction. It then extends that to the historical `events.topic` rewrite by appeal to "SPEC §§6 and 12". Item 21 does retain the rewrite ("boot keeps the `events.topic` rewrite it already has"), so this one is properly anchored.

### A-10. The remove list against `boot-audit.md`'s DELETE verdicts — all of them landed

Every file `boot-audit.md` marked DELETE or MOVE is gone from `packages/boot/src`: `agent-roster.ts`, `storage-usage.ts` (the 166-line walker), `source-watcher.ts`, `source-observation.ts`, `source-tree.ts`, `topic-move.ts`, `topic-move-http.ts`, `topic-page-move.ts`, `topic-page-move-schema.ts`, `topic-move-recovery.ts`, `topic-move-schema.ts`, `scheduled-backup.ts`, `storage-maintenance.ts`. No backup drill remains (`grep -rn 'drill' packages/boot/src` is empty). Boot SSE is gone — the only `text/event-stream` hit is `proxy.ts:402`, relaying a child response, which is not boot originating a stream. The `qrcode` dependency is gone; `packages/boot/package.json` declares exactly four (`@effect/platform-bun`, `@effect/sql-sqlite-bun`, `@simplewebauthn/server`, `effect`), matching item 21's target. `public-pages.ts` is 44 lines, down from 188, which is the §2.1 split executed. The hourly backup schedule left boot: the only `"hourly"` producer is `event-http.ts:238`, reached through `POST /_boot/db/backup` with `x-boot-secret`, i.e. called by the app's cron.

**The one that did not land as a deletion is the topic-move machinery.** Item 27(1) said to delete 228 lines. Codex deleted them and added `legacy-topic-moves.ts` (282). The ownership audit does not mention this file anywhere, in either list. That is a silent omission of the single largest unjustified module in boot.

### A-11. The implied spec changes, and whether each needs an owner call

The audit says "Older feature requirements are identified explicitly where that direction changes them." Here is the full list of what it implies, with status:

| Change implied | Spec touched | In `pr-comments.md`? | Needs a call? |
| --- | --- | --- | --- |
| Retire the anchored edit API for compare-and-set raw writes | §6 route row, §7.5 | No | **Yes.** Already shipped at `ba5866b`. |
| Remove the second issuance workflow (`POST /_boot/tokens` minting) | §6 route row | No — and `boot-audit.md:224` offered it and the owner declined | **Yes.** Directly reverses a §3C item the owner did not take. |
| Remove 7/30-day calendar retention and its settings contract | §6.1 (`SPEC.md:336`) | No — and item 21 says the opposite | **Yes, and I recommend rejecting it.** See A-8. |
| Narrow the single aggregated wide event (drop child annotation aggregation) | `docs/tech.md` §8 | No | **Yes,** though this one is low-risk and clearly right. |
| Remove the Prometheus registry and `GET /_boot/metrics` | §6 route row, §12 | No — item 21 lists `/_boot/metrics` as a row to **implement** | **Yes.** Already shipped at `dd3c6e7`. |
| Move `seedPages` out of boot with a no-reseed migration boundary | §7.1, §11 | No | **Yes,** but the audit's preservation conditions are sound. |
| Remove generic Logger-to-event-store export | None | No | No. Internal. |
| Narrow public boot event reads to lifecycle/failure diagnostics | §6.1, §6.2, §6 route row | No | **Yes.** Already shipped at `2ee17ac`, and it also moved `/api/events` out of boot, which item 21 promised it would not. |

Six of eight need an owner decision that is not in `pr-comments.md`. Three of the six have already shipped.

### A-12 to A-14. What the last four commits did

- **A-12 (`2ee17ac`).** `/api/events` left boot. `event-http.ts:203` is now `const query = url.pathname === "/_boot/events";` — at `5d96c1d` it was `["/_boot/events", "/api/events"].includes(url.pathname)`. The replacement is `packages/server/src/events-http.ts`, which ends the wait on a swap at `:46` (`Effect.raceFirst(ctx.drained.pipe(Effect.map(drained)))`). Two secondary narrowings in the same commit: `/_boot/events` now requires human or `fs` scope (`event-http.ts:225`) where `SPEC.md:289` says `read`; and a non-child caller gets only `since` and `limit` over five event-type globs, losing `types`, `topic`, `agent`, `instance`, `level` and `wait`.
- **A-13 (`dd3c6e7`).** `metrics.ts` deleted and the `/_boot/metrics` handler removed. `docs/pr-1/second-pass-5d96c1d.md:159` had recorded it as fixed. `docs/tech.md:163` still documents the route. The other two rows from item 21's "spend some of the savings" sentence survive: `restart-http.ts:11` and `edit-http.ts:126` (`revert {withDb}`).
- **A-14 (`ba5866b`).** `POST /_boot/fs/edit` deleted; `edit-http.ts` now rejects anything but PUT/DELETE, with `If-Match`/`If-None-Match` on the raw write. `SPEC.md:274` still specifies the route and its `anchor_not_found`/`ambiguous_anchor`/`stale_base` codes. This is the audit's own recommended sequence executed correctly (conditional raw write exposed before the anchored route retired) — the only problem is that no ledger entry authorizes it.

---

## PART B — items 25 to 31 against the code

| Item | Verdict | Evidence |
| --- | --- | --- |
| 25 mentions + over-marking | **FIXED** | Regex fix is a post-hoc trim, `packages/server/src/ext/core/message-mentions.ts:8`: `const target = match[1]?.replace(/[._-]+$/u, "");`. `@codex.`, `@codex-`, `@codex_`, `@codex,`, `(@codex)` all yield `codex`; `@codex.other` and `@codex-job.` are not over-trimmed. Four punctuation cases plus eight negatives at `packages/server/test/mention-read-marks.test.ts:5-27`. Migration is a guarded rung 9 (`ext/core/schema.ts:84-86`, `if (version < 9) { if (version >= 7) yield* reindexMentions(sql);`), paginated, and does not fire the FTS trigger. Over-marking fixed at `ext/core/read-view.ts:14-17` by filtering to `message.topic === topic \|\| message.topic.startsWith(\`${topic}/\`)`; a mentions-only query marks nothing (`ext/core/api.ts:66`). |
| 26 extension route collisions | **FIXED** | Canonicalisation, not a per-extension document catch: `packages/server/src/kernel/extension-routes.ts:29-31` adds `templatePattern`, collapsing a terminal `/*` and `:param` to the same shape; the collision loop at `kernel/ext.ts:238-256` compares it inside the region caught by `Effect.catchCause(... "ext.failed")` at `:278`. End-to-end test at `packages/server/test/extension-routes.test.ts:181-224`: reload stays `live`, only `zz-template.ts` is disabled, `ext.failed` names `core.ts`, `/api/topics/retained` still 200s. `extension_disabled` is now a declared kernel code at `packages/protocol/src/error-code.ts:15` with policy at `errors.ts:71-75` (status 500, so `retriable:false` is derived not asserted) and appears in the served document. **Residual:** `document(selected, documents)` at `kernel/ext.ts:458` is still uncaught, so the structural fragility remains for any future throw in document assembly. |
| 27 finish the boot cut | **PARTLY** | (1) Dead topic-move machinery deleted, but replaced by `legacy-topic-moves.ts` (282 lines) — net +54 and it is now live, not dead. The `/_boot/fs` `SELECT` cost is genuinely gone; the code is not. (2) `bootRoute` preamble **done**: one `checkBootOrigin` at `packages/boot/src/boot-route.ts:26-36` with nine call sites; the only other inline Origin comparison is `proxy.ts:201-206`, a different policy (CSRF on proxied app mutations). (3) `"rahul"` literals: **one**, at `human-agent.ts:2`. (4) Bun cache **persistent**: `preparation-keeper.ts:19-23` resolves `/data/cache/bun`, `BUN_INSTALL_CACHE_DIR` set at `:62`, directory provisioned by `deployment-layout.ts`. **Size unmet**: 12,265 lines in 93 files against 7,250. |
| 28 freeze gates, third time | **PARTLY** | **Queue: FIXED.** `packages/boot/src/traffic.ts:31,44,53` — the wait is now a `Deferred` completed by `release`, with one `Effect.timeout("60 seconds")` over the loop and the comment "One total wait budget covers the 10s drain + 30s backup + 5s health cutover". The budgets add to 45 s (`cutover.ts:227-231`, `:264`, `:271`), so 60 > 45. Queue depth capped at 128 with typed `freeze_queue_full`. **Page publication: FIXED.** `index.ts:212-229` now waits on `events.changed` with both gates dropped, instead of the bare 503 at the old `:138`; covers `PUT\|DELETE /_boot/fs/pages/**` (`edit-http.ts:288`) and page undo (`:190`). **Finalizers: NOT fixed.** `supervisor.ts:272` is `if (cause.reasons.length !== 1 \|\| error._tag !== "Success" \|\| !Schema.is(ChildError)(error.success)) return;` — a non-`ChildError` failure skips `withdraw` and `release` entirely. `start` fails with `TimeoutError` whenever the child misses `value.process.health.pipe(Effect.timeout("5 seconds"))`, and `retire` (`supervisor.ts:154-162`) does not release. Reachable on the unattended hourly backup path via `database-backup.ts` → `supervisor.restart`. Two more escapes: `cutover.ts:342` (`restore(persisted)` failing with `cutover_backup_missing`/`SqlError`) and `supervisor.ts:284` (`resume`'s catch branch itself failing). |
| 29 storage admission on the hot path | **FIXED** | No subprocess remains in the reservation transaction. `admitReservation` still runs inside `sql.withTransaction` (`events.ts:191`→`:217`) but now reads a cached sample: `storage-volume.ts:97` returns the `Ref` value only if `now - current.at <= 5000`, refreshed by a forked 1-second loop at `:99`, wired at `index.ts:80-91`. `readStorageVolume` (`storage-volume.ts:59-71`, the `stat`/`df` spawn) is reached only from that loop. Cold start yields a **retriable** 503 (`event-http.ts:172`), window bounded by the 2-second probe timeout. Policy change re-measures inline (`event-storage.ts:162`); measurement failures are retriable (`event-http.ts:172`, `retriable: status === 503`), genuine over-budget stays 507. Two uncached `SELECT key,value FROM settings` remain inside the transaction per mutation — cheap, but not free. **Platform caveat:** off linux/darwin the probe returns `unsupported_platform` permanently, so every app mutation is refused with a retriable 503 forever. |
| 30 recovery must leave a way in | **PARTLY** | (a) **FIXED.** `index.ts:130-131` is now `return yield* new RecoveryRejected({ code: "recovery_intents_conflict" });` — no `Effect.die` on the recovery path; mapped to a typed 409 at `edit-failure.ts:48-52`, asserted at `packages/boot/test/failed-recovery.test.ts:163-171` with both journals preserved. (c) **FIXED by deletion** — `topic_page_moves` is dropped at startup by `legacy-topic-moves.ts:139-144` and nothing else references the table, so no stale row can outlive a restart or cost a `SELECT` on the fs path. (b) **PARTLY.** `edit-http.ts:54-64` sets `writable = true` for a human-authenticated `POST\|DELETE /_boot/lock` and `POST /_boot/revert` — but only after `editing.retryRecovery(...)` succeeds, and `retryRecovery` re-raises on failure (`index.ts:164`). A persistently failing recovery still refuses both. `GET /_boot/lock` is served from a snapshot that never expires the lock (`edit-lock.ts:237`) and `GET /_boot/recovery` is never phase-gated, so the "503 on everything with no way in" outcome is gone. But the unconditional writability item 30 asked for is not there. Whether that fail-closed choice is right is an owner call the code makes silently. |
| 31 smaller items | **17 of 18 FIXED, 1 PARTLY** | Fixed: `pages-http.ts` typed via a new exhaustive record at `packages/server/src/page-failure.ts:7-18`; lowercase host at `boot/src/enrollment.ts:78` and `token-mint-schema.ts:18`; README catalog; `reactions`/`agents` behind `if (version > 0)` at `ext/core/schema.ts:54-55,:65-66`; one `webhook_subscriptions` DDL; subscriptions error union; `sql-write.ts` registry (`kernel/protected-sql-tables.ts`); `extension-api.ts` free of `ext/core`; event reads off the channel gate; `http.request` wake filtered at `ext/core/message-changes.ts:29-41`; board CSP; recovery-time anonymous page read now retriable 503; `extensions.md` and `standup.ts`; subscriptions example; `bootRoute` preamble; bounded readonly SQL at `kernel/sql-read.ts:60-73` (3 s, subprocess `killSignal:"SIGKILL"`, finalizer awaits `exitCode`). **`ctx.read` bounded** at `kernel/read-snapshot.ts:82-92`: 3 s absolute including the permit wait, `Effect.interruptible` so it is a real interrupt, mutex released on timeout, plus a 4 s guard that flips `lifecycle.healthy = false` and gets the child replaced. **PARTLY:** `topics-http.ts` uses `params.path` now (`:29`) but the classification split moved rather than vanished — `ext/core/topics.ts:17` still returns `query_invalid` where `topic-operations.ts:31` returns `input_invalid`, and `topic-management-http.ts:31-35,59-62` still re-parses `request.url`. **Adjacent, still open:** `kernel/idempotency.ts:21` still enumerates retired families: `const families = ["message", "topic", "read", "reaction"] as const;`. |

### Adjudication: did `75fa8f1` regress the item-28 finalizers?

Two of my agents disagreed. **`75fa8f1` is a refactor, not a lost guard.** Commit `4147a1a` added an `Effect.addFinalizer` to `cutover.ts` and `database-backup.ts` that released only when a `releaseSafe` flag was set — and `releaseSafe` was set under exactly the predicate that now lives in `supervisor.restart`'s `onError` (single-reason cause, `ChildError`, proven closure). `75fa8f1` moved the identical condition into the supervisor and deleted the flag. No path that released before stops releasing.

The defect is in the predicate, not the refactor: it was never fixed. `4147a1a` claimed item 28 and shipped a conditional release gated on `Schema.is(ChildError)`, which does not cover the `TimeoutError` a missed health deadline produces. Item 28 asked to "wrap both regions the way `database-restore.ts:394` does" — unconditionally. That did not happen in either commit.

### Regressions against items 1 to 24

Checked and clean: no boot-originated SSE; no deleted route returned (`/api/read`, `/api/inbox`, `/api/ctx`, `/api/reactions`, `/api/agents`, `/api/search`, `PATCH /api/me`, `?budget=` all absent); no `handleRaw` anywhere; the `100 millis` relay loop and `10 millis` drain busy-wait in `server.ts` are both gone, replaced by `kernel/publication.ts:43` and a 4-second `lifecycle.awaitIdle`; no production deadline was quietly lengthened (the one increase, `traffic.ts:53` from 10 s to 60 s, is item 28's requested fix); `packages/server/src/kernel/` contains no domain file and imports nothing from `../ext/core`; item 21's CI invariant is enforced by something stronger than the grep — `scripts/check-invariants.ts:81` is an AST walk over every SQL literal in `packages/boot/src`, wired into `bun run check` and `.github/workflows/linux.yml:49`, and it passes.

Genuine regressions, all deliberate and all unrecorded: the four route removals in A-12 to A-14, plus `legacy-topic-moves.ts`. One minor item-6 drift: `backup-http.ts:61` deepened a status ternary from two branches to three (`{ status: unsafe ? 409 : unavailable ? 503 : 507, ... }`) three lines below an exhaustive record in the same file.

### Not verified

The full test suite was not run. Whether the tests still assert the old `/api/events`-in-boot contract is unchecked, though `2ee17ac` rewrote `packages/boot/test/event-delivery.test.ts`. The audit's claim that `a834e3f` passed 782 tests in 519 seconds was taken at face value.
