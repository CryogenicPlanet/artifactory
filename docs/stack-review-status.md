# Database stack review status

Read this alongside the [build plan](build-plan.md). This is a triage checkpoint, not a claim that reviewers have resolved their comments. Earlier accepted checkpoints include #7 `ddf0c67`, #8 `1739ee7` and runtime #9 `a6db9c5`. Current evidence distinguishes exact local `4587a6c`, transfer CI tested merge `058c278` and runtime repair tested merge `03d899a`; all top acceptance checks and the subsequent keeper-fixture image rerun pass at their named tested merges. Earlier #2–4 named fixes remain checkpoint-scoped. No new reviews were found at this acceptance checkpoint. Earlier #2–4 statuses below remain scoped to their named fixes. Subsequent worker commits require integration and verification before changing a status here. No tests were run for this audit.

**Statuses:** **pending** needs a fix, decision, evidence or disclosure; **already fixed** has evidence in the named pushed layer; **runtime-only** has implementation in the separate runtime checkout but does not resolve the lower PR; **disagreement** identifies a review premise that needs clarification rather than silently changing behavior.

## Review inventory

The full issue comments were read: [PR #2 review](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5644305395), [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307), and [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084). At the earlier inventory checkpoint, GitHub's paginated pull-request review and inline-comment endpoints were also queried for #2, #3, #4, #7 and #8. Each of #2–4 has one older formal review and no inline comments; #7/#8 have neither formal reviews nor inline comments at that checkpoint. This does not substitute for their separate issue-comment review work.

Older formal reviews: [#2](https://github.com/CryogenicPlanet/artifactory/pull/2#pullrequestreview-5180528233), [#3](https://github.com/CryogenicPlanet/artifactory/pull/3#pullrequestreview-5180528413), [#4](https://github.com/CryogenicPlanet/artifactory/pull/4#pullrequestreview-5180528628). Their still-relevant asks are included below. Parallel writers own the #2–4 fixes; this document does not supersede their scopes.

An earlier incremental issue-comment and review-body refresh after 2026-09-12 06:59:22 UTC found no new comments on #2, #3, #4, #7, #8 or #9 at the time. That issue-comment inventory is superseded by the complete PR #7/#8 reviews below; the earlier formal/inline inventory remains historical evidence.

Historical focused evidence: #2 had 11 passes; #3 had 25; #4 had 34 plus an overlapping 62-case core group; #7 had 49 schema passes. Later terminal-refusal/copy-fixture/public-metadata corrections passed seven, eleven and one case respectively. These overlapping focused groups remain historical; current combined acceptance appears below.

## PR #2: descriptors

All rows refer to the [PR #2 review](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5644305395), including its smaller notes.

| Finding | Status and next action |
| --- | --- |
| Old boot cannot launch descriptor-aware installed code after image rollback | **Already fixed** in `576476f`: alias-derived fallback retains conflicting-pair refusal; focused child compatibility evidence passes. |
| `render` accepts paths its parser rejects | **Already fixed** in `576476f`: rendering validates file paths before producing descriptors, with rejected-character coverage. |
| Server-to-boot import guard is too broad | **Already fixed** in `576476f`: launcher-only exception and an import-boundary test. |
| Errors omit variable names; relative `DATA_DIR` is unresolved | **Already fixed** in `576476f`: resolved data-directory selection and safe variable-specific descriptor diagnostics. |
| Descriptor-only and mismatched pairs lack real child acceptance | **Already fixed** in `576476f`: real child descriptor-only and conflicting-pair cases. |
| `render` must return `Redacted` | **Already fixed** in #2; the wrapper and its secrecy assertion are present. |
| URL scrubbing and three credential boundaries | **Runtime-only named boundaries audited/implemented.** Read-worker credentials use bounded private stdin, not argv; worker stderr is ignored. Child config decode uses a fixed refusal message and retained child diagnostics use scoped redaction. This is not blanket leak-proof acceptance; lower-layer obligations remain separate. |
| Remote alias form and retained-generation contract stamp | **Runtime-only implemented** in `e41cfe6`: immutable source `package.json` storage-engine declaration is checked before ownership/spawn; unstamped source remains SQLite-only and essential rollback stays ungated. Remote aliases are absent/refused. |
| Mutable authoritative store pointer | **Runtime-only implemented.** The service reads durable `app_store_database`/adoption state; restore pointer and phase update in the boot transaction before prepare/launch. No extra mutable wrapper is needed. |
| PR body names stale validation head | **Disclosure complete in [PR #2](https://github.com/CryogenicPlanet/artifactory/pull/2).** Its body distinguishes descriptor checkpoint `d062269`, reviewed `1ef641e` with two later test-only commits, and current `576476f` validation. |
| Heading fixture repair predates descriptor work | **Code and disclosure complete.** The PR #2 body identifies `d6509bf` as a stale base `/init` assertion repair, not descriptor behavior. |
| Fixture consolidation, including `:memory:` | **Partly implemented in current runtime.** Shared engine-selected fixtures and a shared focused behavior group are integrated; this is not conversion or acceptance of the entire suite under every engine. Remaining consolidation/design reconciliation stays open. |
| Design list/path/error-code drift | **Package/code disclosure complete; broader API reconciliation remains open.** PR #2 names `packages/storage/src/store.ts` and `store_descriptor_mismatch`, and distinguishes deferred runtime methods. Owner design files remain unchanged. |
| New lint warning and tab-sensitive legacy fixture synthesis | **Lint already fixed** in `576476f` with `filterOrFail`; tab-sensitive fixture maintenance remains pending. Retain a loud failure if instrumentation no longer applies; do not weaken the compatibility scenario. |
| Keeper acceptance caveat | **Already available for PR #2 `576476f` as separate CI evidence.** Later stack heads need their own verification; ordinary unit tests alone do not execute the privileged image path. |

## PR #3: identity

All rows refer to the [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307).

| Finding | Status and next action |
| --- | --- |
| Ready adoption pins absolute path and breaks supported layout migration | **Already fixed** in `2ebc95e`: pending adoption remains path-bound; ready adoption uses UUID, with authenticated selected/recorded-location diagnostics and relocation coverage. |
| Identity refusal prevents journal recovery and disarms restore | **SQLite repair already implemented in lower #3 `c4e4bd2`.** Offline restore preserves exact before-images or original absence before installing a matching backup; journal recovery precedes a new identity reservation. Remote repair belongs to #9 and its separately recorded native/image acceptance. |
| Abandoned `.restore-*` copies and early legacy stamps | **Already fixed** in #3: deterministic staging reclamation and completed-adoption-only, NULL-guarded legacy provenance. Legacy fixed-path residue was a distinct finding, fixed separately below. |
| Legacy `<store>.restore` residue remains forever | **Already fixed** in `2ebc95e`: known legacy staging and sidecars reclaimed after positive closure. |
| Foreign identity reported as missing; identity absent from diagnostics | **Runtime diagnostics fixed** in `50122ca`: authenticated diagnostics include safe observed/expected UUID and selection/adoption details. Modern backup catalogue UUID provenance is explicitly `not_recorded`; do not populate legacy provenance to simulate it. |
| Pre-upgrade refusal unreachable through HTTP | **Already fixed** in `2ebc95e`: permanent `boot_identity_upgrade_pending` HTTP 409 preserves old schema/journals. |
| Shape probe emits bare SQL errors and differs by adoption mode | **Already fixed** in `2ebc95e`: populated stores receive consistent shared-table shape probes with coded refusal. |
| Existing populated app store adopted under fresh boot state | **Partly fixed** in `2ebc95e`: shared outbox/batch high-water evidence ahead of boot refuses adoption. This does not prove freshness or discover domain rows after shared evidence has been pruned. |
| Editable migrations can destroy protected identity/recovery tables | **Integrated in runtime.** SQLite and portable protected migration-state checks now run at the named boundaries (`aae09da`, 25 focused cases). Trusted code must return for validation; explicit commits, independent connections and arbitrary executable dependencies remain outside this guard. Lower-layer editable-receipt protection is now composed in `c30178a`. |
| Same UUID does not prove freshness of a self-copy | **Already disclosed** in `2ebc95e` storage documentation: identity proves the board, not recency; use explicit restore rather than replacing same-UUID files. |
| Withdrawal status change omitted; failure reason remains empty | **Runtime fixed** in `50122ca`: stale live PID/port invalidation is retained and `route_withdrawn` supplies a bounded reason. |
| Historical Linux held-marker failures unexplained | **Disclosure complete in [PR #3](https://github.com/CryogenicPlanet/artifactory/pull/3); historical cause remains unknown.** The body explicitly separates later green checks from the unexplained held-marker failures. No retrospective diagnosis is claimed. |

## PR #4: backup operations

All rows refer to the [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084).

| Finding | Status and next action |
| --- | --- |
| Rung 18 skips the v17 pending-recovery upgrade guard | **Already fixed** in `612d4ac`: guard extends through v17 before migration, with focused schema acceptance. |
| Step-2 API/copy budgets are absent or undisclosed | **Bounded SQLite copy implemented; remaining contract/acceptance work.** Keeper-owned copy lifetimes and deadlines are composed in `ef47bba`; corrected ownership fixtures pass eleven cases. Reconcile remaining deferred API names/result-descriptor promises with actual journal selection behavior; no inert wrapper or focused test establishes full runtime/image acceptance. |
| Backup inserts and capture response omit engine | **Already fixed** in `612d4ac`: explicit service dialect/provenance on all inserts and capture response, included in focused acceptance. |
| Rollback fabricates SQLite engine | **Already fixed** in `612d4ac`: forwards catalogued engine; foreign provenance remains refused. |
| Foreign-engine rows consume an unprunable budget | **Already fixed** in `612d4ac`: foreign artifacts stay preserved and are excluded from this engine’s catalogue budget; physical headroom still counts their bytes. |
| Artifact naming bypasses `backupPath` and lacks engine parameter | **Already fixed** in `612d4ac`: engine-aware `.db`/`.dump`/`.sql` naming is shared by writers, validators and retention. |
| Descendant helper belongs in dialect tranche; one statement mixes forms | **Pending scope decision; runtime-only conversion.** Portability work exists separately, but that does not remove the helper from #4 or verify all callers. Complete literal-prefix semantics and non-ASCII behavior tests in its intended layer. |
| Image/Linux/QEMU acceptance missing; production delta claim wrong | **Already fixed** at pushed `7d47607`, as acknowledged by the new review. Do not substitute the separate 848-test/8-skip run for this PR's own result. |
| Old ledgers show +38 lines and failed historical CI | **Disclosure complete in [PR #4](https://github.com/CryogenicPlanet/artifactory/pull/4).** Its body labels the old line-count estimate and failed CI entries as superseded historical status, not current measurements or newly diagnosed causes. Preserve those historical entries. |
| Schema rungs taken before unresolved base migrations | **Pending integration discipline.** Preserve IDs and validate complete histories/compatibility; a textual restack cannot establish migration correctness. |

## PR #7: complete ledger review

[Review 5644472625](https://github.com/CryogenicPlanet/artifactory/pull/7#issuecomment-5644472625) was read completely. The new implementations below are integrated in pushed `c30178a` and runtime `50122ca`; current lower heads and runtime pass their checks.

| Finding | Disposition |
| --- | --- |
| Ledger versus mirror authority | **Integrated** in `c30178a`: validated ledger prefix is authoritative; mirror-ahead/newer-schema refusal remains. |
| Repeated ladder ceilings | **Integrated** in `c30178a`: targets derive from declared steps. |
| Historical adoption fixture built by current code | **Integrated** in `c30178a`: independent v16/v18 SQL, catalogue and provenance fixtures. |
| Missing boot post-adoption shape checks | **Integrated** in `c30178a`: required-column probes run transactionally before adoption commits. |
| `api.migrate` destroys bookkeeping | **Already fixed** in lower and runtime through migration-state preservation, with the documented trusted-code limits. |
| Raw SQL can delete editable `migrations` receipts | **Integrated in lower and runtime** through `579be1e`, composed in `c30178a`. |
| Opaque corruption errors | **Integrated** in `c30178a`: coded safe corruption reasons and numeric expected/found diagnostics. |
| Successful no-op initialization lacks physical-byte test | **Tests integrated** in `c30178a` for historical boot adoption and both ledgers; the earlier `50122ca` combined suite passed; current transfer acceptance remains separate. |
| Stable migration names / portability of ledger invariants | **Disagreement resolved by review itself.** Both allegations were explicitly refuted; no change required. |

## PR #8: complete dialect/remote-foundation review

[Review 5644467131](https://github.com/CryogenicPlanet/artifactory/pull/8#issuecomment-5644467131) was read completely. New lower fixes are pushed in `ac3fada` and composed in runtime `50122ca`; runtime-only obligations remain labeled.

| Finding | Disposition |
| --- | --- |
| Published JSON CASE casts/schema representation | **Lower casts/codecs integrated** in `ac3fada`; native core JSON column migration is **runtime-only**, `0b282c0`. The three-case native groups exercise migration/recovery and dialect behavior, not every JSON path. |
| Main and KV snapshot helpers | **Integrated in lower and runtime** through `ac3fada`, with nested snapshot boundary fixtures. |
| Remote dialect edge semantics unexecuted | **Coverage integrated** in `ac3fada`: literal/non-ASCII prefixes, JSON/null/arrays, published images, nested snapshots and production topic moves. Do not claim exhaustive topic/tag/mention coverage. |
| MySQL `incoming_seq` alias | **Allegation not substantiated.** Native move/collision fixtures preserve higher cursors; `dc8e1f0` fixes reserved `reads` quoting, not the alleged alias defect. |
| Public paths use SQLite descendants | **Runtime-only behavior fixed.** Lower remains open; obsolete helper/export cleanup is separate. |
| Null-safe event exclusion | **Runtime-only fixed** with `distinctFrom`; lower remains open. |
| GLOB/planner hints | **Runtime-only behavior fixed.** Unused helper cleanup is separate from the SQL correctness issue. |
| Singleton mutation/edit admission locks | **Runtime-only fixed** at allocator/lock boundaries; lower remains open. |
| Prefix rewrites use SQLite concatenation | **Runtime-only fixed** in events/public paths; lower remains open. |
| KV/system upserts invalid on MySQL | **KV already fixed in lower #8 `1739ee7`; system caller is runtime-only.** `extension-data.ts` uses the MySQL `ON DUPLICATE KEY` branch, while lower `system.ts` retains `ON CONFLICT`. The runtime conversion does not change the lower system caller; no generic helper is required. |
| MySQL REPEATABLE READ not asserted | **Assertion and negative coverage implemented in lower #8 `1739ee7`.** Lease admission checks isolation; the native session fixture changes all four leases to READ COMMITTED and verifies six refusals with `remote_isolation_unsupported`, no body entry and unchanged registration. [Guarded native session CI](https://github.com/CryogenicPlanet/artifactory/actions/runs/34691252728) passes. |
| URL redaction before persisted stderr | **Runtime-only fixed** at reviewed child/supervisor boundaries with scoped redaction and adversarial coverage. |
| TLS/private CA configuration | **Runtime verified** at `1b883b6`: actual private-CA TLS acceptance passes, including correction of the observed MySQL hostname defect. Unsupported client-certificate/servername configuration remains separate. |
| Lease/registration latency absent from budget | **Local baseline measured; broader operational acceptance remains open.** The [benchmark](../scripts/native-database-benchmark.md) records PostgreSQL/MySQL reload freezes of 828/895ms and native dump/load samples, including 100,000 synthetic rows. These do not isolate lease-registration cost, establish managed-server budgets or measure complete transfer downtime. Preserve ownership checks. |
| Historical red CI omitted | **Disclosure improved; historical causes not all proved.** Keep exact failed checkpoints separate from newer passes. |
| PostgreSQL 18.6 versus pinned 17.11 | **Corrected documentation/evidence scope.** Native and pinned-image runs are separately identified; neither proves the other version. |

## Runtime and transfer checkpoint

Exact transfer integration `4587a6c` passes the combined full suite with actual Node 22.22.3 and two workers: **1,237 passed and 123 skipped (1,360 tests)**, across **278 passed files and 47 skipped (325 files)**, in **695.07s**. Check, build and fresh composition review pass. Transfer head `a8e96c2` at tested merge `058c278` also passes Linux with 1,237 tests passed and 123 skipped, across 278 passed files and 47 skipped, plus image, QEMU, both native parity groups, both boards and all twelve transfer scenarios. All twelve repair cases per engine also pass at that merge; all reported checks are green. The final documentation/keeper-fixture composition may start new CI runs, which retain their own tested-checkout attribution.

The previous transfer head `2073a3e` passed Linux at tested synthetic merge `557dde4`: **1,227 tests passed and 120 skipped**, across **275 passed files and 47 skipped files**. All six normal image transfer directions and six copy/retirement/activation crash scenarios passed again. This accepts those workflows at that merge, not every newer runtime change. The earlier [twelve-scenario transfer run](https://github.com/CryogenicPlanet/artifactory/actions/runs/34701968755) tested `f1d785e` associated with `fd4edb9`.

The runtime retains pinned nonblocking remote read snapshots, scoped connection disposal, shared SQLite/PGlite groups, portability warnings, PostgreSQL accent-folding fallback, MySQL token/stopword handling, identity collations and native repair. New focused acceptance covers per-file MySQL migration epoch checks (including a negative control), two-file native migration/rehearsal chains on PostgreSQL and MySQL, and restore-forward reuse of the existing rehearsal on both engines. Failed-health pre-flip recovery and the complete repair scenarios now pass on both engines in runtime CI. WAL fixtures pass eleven cases. SQLite restore-forward evidence is thirteen initial passes plus one corrected case in 8.72s, not one clean fourteen-case run. Shared mutation four-case, outbox twelve-case and read-mark four-case groups pass on default and native engines and are now wired into CI; this is focused parity, not full-suite parity.

Prior repair failures were traced to retained artifacts exhausting a shared container's `/tmp`: `ENOSPC` and the 5% headroom refusal were observed. Fresh-container isolation now passes in runtime `8bfc6e5` at tested merge `03d899a`: both native boards and all twelve cases per engine (nine repair including migration/restore-forward, two shutdown and one foreign-store case) pass, alongside both Linux shards. Preserve refusal and failed artifacts rather than lowering the storage reserve. That runtime image job failed a keeper fixture with SQLite BUSY; the subsequent one-line bounded timeout correction `deea721` passes image CI at tested merge `25406df`, including keeper closure, preserved writes and restart proof. A controlled probe succeeded after a 200ms lock (234ms elapsed) and still refused a 1,400ms lock with BUSY after 1,129ms. This is fixture evidence, not a production deadline change.

The [native benchmark](../scripts/native-database-benchmark.md) now includes verified 100,000-row local dump/load samples. These synthetic single-table timings do not measure full-board capacity, complete offline-transfer downtime or managed-server latency budgets. Remaining build-plan obligations include broader portable-suite coverage and measured operational budgets; no acceptance check remains pending for the named verified code checkpoints. Direct DDL, MySQL views/triggers and failed-clone retention remain unresolved design/scope disagreements, not owner-approved restrictions. Lower-layer review obligations and base review items remain separately tracked; no all-comments-resolved or full-goal claim is made.

Historical local `fd4edb9` full evidence remains **1,222 passed, five failed and 119 skipped (1,346 tests)**; **272 passed files, three failed and 46 skipped (321 files)**, **721.29s**, actual Node 22.22.3 and two workers. All five failures were confirmed fixture issues; separate corrected groups passed recovery six cases in 20.27s, launcher one in 2s and source-session two. Later green CI does not erase this failed checkpoint.

### Earlier accepted runtime and failure evidence

Exact `50122ca` full local acceptance: **1,041 passed and 63 skipped (1,104 tests)**; **234 passed files and 27 skipped (261 files)**, **714.22s**, actual Node 22.22.3 with at most two workers (`/tmp/comms-runtime-full-50122ca.log`). Exact-head [Linux](https://github.com/CryogenicPlanet/artifactory/actions/runs/34691445242) also passes 1,041 with 63 skipped; [actual boards](https://github.com/CryogenicPlanet/artifactory/actions/runs/34691445279), [remote checks](https://github.com/CryogenicPlanet/artifactory/actions/runs/34691445330), [QEMU](https://github.com/CryogenicPlanet/artifactory/actions/runs/34691445200) and image pass. No new reviews were found at this checkpoint.

The documentation successor `a6db9c5` also passes all exact-head CI, including [Linux](https://github.com/CryogenicPlanet/artifactory/actions/runs/34692524735), both actual-board jobs, remote checks, image and QEMU. PRs #2–4/#7/#8 remain green and no new reviews were found.

The accepted integration includes native JSON columns/codecs and crash recovery, portable migration protection, guardian/copy closure, and the production freeze/admitted-forward race correction. `50122ca` adds safe observed-store UUID and `route_withdrawn` diagnostics; modern backup catalogue identity provenance is honestly reported as `not_recorded`, not reconstructed or fabricated. Native PostgreSQL 18.6 and MySQL 8.4.11 full board flows remain distinct from pinned PostgreSQL 17.11/MySQL 8.4.11 image evidence. MySQL's second-backup check proves creation and closure, not an independent restore of that artifact.

Historical failures remain evidence: `709ae2c` local full suite had 1,019 passed, one failed and 59 skipped (1,079), across 231 passed files, one failed and 24 skipped (256), in 655.69s; its Linux run had 1,018 passed, two failed and 59 skipped. The stale preparation anchor and real admission/freeze race were corrected. `edea32c` subsequently had **1,036 passed, five failed and 63 skipped (1,104)**, across **232 passed files, two failed and 27 skipped (261)**, in **718.79s**. Those five failures came from synthetic legacy fixtures lowering only the version mirror while retaining the current ledger; three fixture setup lines correct them. Earlier PR #8 `ac3fada` normal-instrumentation CI had five passed, one failed and two skipped after restart; a test-order correction removes a possible stale-port hazard, but the old log does not prove a port remap or production isolation defect. New exact-head greens do not retroactively prove that historical cause.

## Acceptance before closing findings

Each fix needs an exact pushed commit, focused evidence appropriate to failure cost, and integration review. Runtime-only implementations do not close lower-stack comments. Recheck GitHub heads and any new reviews before posting a response; do not mark all review comments resolved from this checklist. Current runtime, real-board and image acceptance is recorded above; transfer and remaining per-finding obligations remain in the build plan.
