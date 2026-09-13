# Database stack review status

Read this alongside the [build plan](build-plan.md). Review fixes are integrated at transfer `3db1bc0`, including runtime `ae04432`. Hosted CI is terminal with the failures below; the combined local suite also finished with failures under actual Node 22.22.3 and two workers. Final acceptance remains open. No earlier green result accepts this new composition.

PR2 merged its older `2bb3922` checkpoint. Descriptor follow-ups now travel through PR3 `92fbd7b`, then PR4 `0d84963`, PR7 `0085b6a` and PR8 `f1f16e6`. A newer commit on the merged PR2 branch does not revise what merged.

## Latest acceptance — 13 September, after 02:16 UTC

| PR / submitted head | Actual CI merge | Linux main-suite result |
| --- | --- | --- |
| PR3 `92fbd7b` | `015b4f87` | [861 passed, 1 skipped](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730744634) |
| PR4 `0d84963` | `460dd339` | [885 passed, 1 skipped](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730744910) |
| PR7 `0085b6a` | `6942368f` | [931 passed, 1 skipped](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730744478) |
| PR8 `f1f16e6` | `743700b2` | [951 passed, 11 skipped](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730744644) |
| PR9 `ae04432` | `ec4b0f11` | [1,090 passed, 3 failed, 96 skipped](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730928177) |
| PR10 `3db1bc0` | `52832b9b` | [1,263 passed, 2 failed, 123 skipped](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730985389) |

All listed image/QEMU jobs pass; PR8/9/10 remote-client matrices pass. Both native boards and all repair lanes pass on PR9/10. [PR10 transfer acceptance](https://github.com/CryogenicPlanet/artifactory/actions/runs/34730985429) passes all 12 normal/crash scenarios. These checks do not erase the Linux failures or accept forthcoming corrections.

The common Linux failures are search-faults setup adding an already-present core14 `extension` column, and retired-reactions restart refusing during initialization with `sql_failure`. Both have assigned investigations. PR9 additionally times out after six real revert operations: roughly 2s setup plus six 10s operations exceeds its 60s aggregate (last response 63.646s). Its test-budget correction is under review; do not attribute hosted CI to local sleep.

Local exact `3db1bc0` is terminal: **1,253 passed, 12 failed, 123 skipped (1,388 tests)**; **275 passed, 9 failed, 47 skipped files (331 files)**, **2,719.06s**, actual Node 22.22.3 and two workers (`/tmp/comms-final-full-3db1bc0.log`). OS records confirm 30m01s of sleep during it, including 934s/628s intervals closely matching two unusually long failure groups (`/tmp/comms-final-full-3db1bc0-sleep.md`). This establishes interrupted execution, not the cause of every failure. Preserve the terminal assertions and verify affected behavior separately while awake before acceptance. The two common failing cases also fail hosted CI, independently of local sleep.

## Current review dispositions

| Review | Integrated change / remaining acceptance boundary |
| --- | --- |
| [PR2 verification](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5649766906) | Canonical rehearsal paths, alias-only keeper handling and missing-input diagnostics are implemented through PR3. Genuine historical compatibility fixtures replace synthesized source. Remote child transport, retained stderr and SQL read-worker credential boundaries are owned by PR9. |
| [PR3 verification](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5649764394), [repeat against older cb47ffb](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5649952371) | Isolated layout diagnostics no longer veto repair admission; authoritative identity checks still decide launch. Before-image parent checks wait until filesystem operations. Signed isolated restore and its negative control exercise the production flag. Safe identity/withdrawal diagnostics and missing-boot-marker refusal are composed below and in runtime. |
| [PR4 verification](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5649766975) | Descriptor return, layer responsibility map, provenance and quota fixes are integrated. App backup requests inherit engine-specific copy budgets plus a finite response allowance. Unattended power-loss recovery requires supported Linux boot identity; absent both that evidence and a keeper receipt, recovery safely refuses. |
| [PR7 verification](https://github.com/CryogenicPlanet/artifactory/pull/7#issuecomment-5649767038) | Reviewer accepts all eight original findings. The three additional notes have runtime solutions in PR9 `ae04432` and PR10 `3db1bc0`. Bounded PR7/8 backports `44b3dc8`/`176dfa65` pass check/review and have focused testing pending; dynamic-registry lifecycle remains in runtime. Safe lifecycle handling requires core14 ownership provenance; loading the old name-only registry alone would block valid owner upgrades or guess legacy ownership. |
| [PR8 verification](https://github.com/CryogenicPlanet/artifactory/pull/8#issuecomment-5649764457) | Lower read-mark quoting, portable SQL-publication JSON and guarded raw-JSON CI wiring are integrated in `f1f16e6`; portable boot/system callers remain composed. Reviewer explicitly withdrew incoming_seq. Native coverage names dialect fragments, published messages/topics, topic moves, cursor/publication, snapshots and raw JSON; it is not complete query-suite parity. |
| [PR1 items 44–50](https://github.com/CryogenicPlanet/artifactory/pull/1#issuecomment-5643136461) | Mention/root-mark fixes, pre-upgrade legacy refusal, budget maintenance, safe repair/revert admission, reserved-route readiness dispatch, batched public paths, empty-stream pacing and cleanup diagnostics are integrated. Repair responses distinguish committed operations from later recovery failures. Core14 adds target-aware protection, explicit ownership and retirement; core13 remains the separate replayable mention reindex. |
| Protection and transfer | Shared declaration checksums include protection options; transfer verification binds the same declarations and ownership records (`2192a4c`, `58ff7f3`). Four migration histories retain their existing IDs. Native CI passes at the merge above; combined acceptance remains open because Linux failed. |
| Retention and budgets | Request diagnostics evict before lifecycle history; source-revert outcomes have no calendar expiry. Scoped memory fixtures and measured native lease-cost arithmetic are integrated. Recovery tests exercise consecutive real health deadlines; measurements do not establish a universal wall-clock bound through uncertain ownership closure. |

The identical DROP/recreate allegation is refuted by the existing temporary-schema guard inventory. Regression `bdac589` drops/recreates identical schema and rows and checks refusal, unchanged rows and ledger; its reported focused groups passed separately (3/3 in 1.93s and 7/7 in 13.55s, Node 22.22.3). This is additional regression evidence, not a new production guard or proof of an exact lower-PR test run.

The user's later ownership decisions cover 35/36/47: boot-only lifecycle/request diagnostics, no convenience calendar pruning or retired topic-move coordinator, and preserved source versioning/revert. Direct DDL, custom MySQL views/triggers, general failed-clone retention and complete engine parity remain broader design limitations. They are not substitutes for resolving actual review findings. Owner documents remain untouched.

## Historical per-finding record

The superseded handoff mapping was: mentions `d98628b` → `debe90e`; legacy refusal `d023281` → `70964d5`; readiness `f40eaa0` → `b6672b8`; stream/help `0f13c21`; public paths `5d087de`; cleanup `1bcf41f`; request retention `a1d2eaa`; source outcomes `23db345`; fixtures `e60a424`; lease accounting `ea3cc83`. These identify preparation/composition provenance, not separate current acceptance.

The following tables retain the commits and evidence from earlier review checkpoints. Their frozen/composed labels describe those checkpoints; the integrated disposition above supersedes them. Historical failure causes remain unknown where evidence did not establish one. Neither implementation nor passing tests imply reviewer approval.

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
| Fixture consolidation, including `:memory:` | **Frozen follow-up `e60a424`.** Scoped memory-store construction is consolidated alongside existing shared SQLite/PGlite/native groups. Physical SQLite fixtures remain physical tests; no full four-engine suite claim. |
| Design list/path/error-code drift | **Package/code disclosure complete; broader API reconciliation remains open.** PR #2 names `packages/storage/src/store.ts` and `store_descriptor_mismatch`, and distinguishes deferred runtime methods. Owner design files remain unchanged. |
| New lint warning and tab-sensitive legacy fixture synthesis | **Lint already fixed** in `576476f`; **frozen `29d05a3`** replaces tab-sensitive synthesis with a genuine pre-descriptor generation fixture. Combined acceptance remains pending. |
| Keeper acceptance caveat | **Already available for PR #2 `576476f` as separate CI evidence.** Later stack heads need their own verification; ordinary unit tests alone do not execute the privileged image path. |

## PR #3: identity

All rows refer to the [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307).

| Finding | Status and next action |
| --- | --- |
| Ready adoption pins absolute path and breaks supported layout migration | **Already fixed** in `2ebc95e`: pending adoption remains path-bound; ready adoption uses UUID, with authenticated selected/recorded-location diagnostics and relocation coverage. |
| Identity refusal prevents journal recovery and disarms restore | **SQLite repair already implemented in lower #3 `c4e4bd2`.** Offline restore preserves exact before-images or original absence before installing a matching backup; journal recovery precedes a new identity reservation. Remote repair belongs to #9 and its separately recorded native/image acceptance. |
| Abandoned `.restore-*` copies and early legacy stamps | **Already fixed** in #3: deterministic staging reclamation and completed-adoption-only, NULL-guarded legacy provenance. Legacy fixed-path residue was a distinct finding, fixed separately below. |
| Legacy `<store>.restore` residue remains forever | **Already fixed** in `2ebc95e`: known legacy staging and sidecars reclaimed after positive closure. |
| Foreign identity reported as missing; identity absent from diagnostics | **Composed below in `f3117fb`**, following runtime `50122ca`: safe observed/expected UUID and selection/adoption diagnostics. Modern backup provenance stays `not_recorded`; do not fabricate it through legacy fields. |
| Pre-upgrade refusal unreachable through HTTP | **Already fixed** in `2ebc95e`: permanent `boot_identity_upgrade_pending` HTTP 409 preserves old schema/journals. |
| Shape probe emits bare SQL errors and differs by adoption mode | **Already fixed** in `2ebc95e`: populated stores receive consistent shared-table shape probes with coded refusal. |
| Existing populated app store adopted under fresh boot state | **Composed below:** `fcbb7a9`, included in `f3117fb`, refuses legacy app adoption without its initialized boot marker, including when shared evidence was pruned. It does not inspect product tables or promise same-UUID freshness detection. |
| Editable migrations can destroy protected identity/recovery tables | **Integrated in runtime.** SQLite and portable protected migration-state checks now run at the named boundaries (`aae09da`, 25 focused cases). Trusted code must return for validation; explicit commits, independent connections and arbitrary executable dependencies remain outside this guard. Lower-layer editable-receipt protection is now composed in `c30178a`. |
| Same UUID does not prove freshness of a self-copy | **Already disclosed** in `2ebc95e` storage documentation: identity proves the board, not recency; use explicit restore rather than replacing same-UUID files. |
| Withdrawal status change omitted; failure reason remains empty | **Composed below in `f3117fb`**, following runtime `50122ca`: stale PID/port invalidation and bounded `route_withdrawn` reason. |
| Historical Linux held-marker failures unexplained | **Disclosure complete in [PR #3](https://github.com/CryogenicPlanet/artifactory/pull/3); historical cause remains unknown.** The body explicitly separates later green checks from the unexplained held-marker failures. No retrospective diagnosis is claimed. |

## PR #4: backup operations

All rows refer to the [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084).

| Finding | Status and next action |
| --- | --- |
| Rung 18 skips the v17 pending-recovery upgrade guard | **Already fixed** in `612d4ac`: guard extends through v17 before migration, with focused schema acceptance. |
| Step-2 API/copy budgets are absent or undisclosed | **Composed below in `a5a981d`:** `730c9c8` returns the durable SQLite selection; `3d3bbac` maps the actual API and layer responsibilities. Existing `ef47bba` supplies bounded keeper-owned copies. New combined acceptance remains pending. |
| Backup inserts and capture response omit engine | **Already fixed** in `612d4ac`: explicit service dialect/provenance on all inserts and capture response, included in focused acceptance. |
| Rollback fabricates SQLite engine | **Already fixed** in `612d4ac`: forwards catalogued engine; foreign provenance remains refused. |
| Foreign-engine rows consume an unprunable budget | **Already fixed** in `612d4ac`: foreign artifacts stay preserved and are excluded from this engine’s catalogue budget; physical headroom still counts their bytes. |
| Artifact naming bypasses `backupPath` and lacks engine parameter | **Already fixed** in `612d4ac`: engine-aware `.db`/`.dump`/`.sql` naming is shared by writers, validators and retention. |
| Descendant helper belongs in dialect tranche; one statement mixes forms | **Composed below:** `5d14a34` removes the extraction from the SQLite backup tranche; `a9c510a` completes portable callers in the dialect layer with literal/non-ASCII coverage. |
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
| Public paths use SQLite descendants | **Composed below in `a9c510a`:** portable public-path callers replace the obsolete SQLite path; runtime equivalent already existed. |
| Null-safe event exclusion | **Composed below in `a9c510a`** with `distinctFrom`; runtime equivalent already existed. |
| GLOB/planner hints | **Composed below in `a9c510a`:** portable prefix predicates and removal of SQLite planner hints. |
| Singleton mutation/edit admission locks | **Composed below in `a9c510a`** at allocator/edit-lock admission boundaries. |
| Prefix rewrites use SQLite concatenation | **Composed below in `a9c510a`** in events/public paths. |
| KV/system upserts invalid on MySQL | **KV already fixed in lower `1739ee7`; system composed below in `a9c510a`.** Both choose supported MySQL upsert syntax; no generic wrapper is required. |
| MySQL REPEATABLE READ not asserted | **Assertion and negative coverage implemented in lower #8 `1739ee7`.** Lease admission checks isolation; the native session fixture changes all four leases to READ COMMITTED and verifies six refusals with `remote_isolation_unsupported`, no body entry and unchanged registration. [Guarded native session CI](https://github.com/CryogenicPlanet/artifactory/actions/runs/34691252728) passes. |
| URL redaction before persisted stderr | **Runtime-only fixed** at reviewed child/supervisor boundaries with scoped redaction and adversarial coverage. |
| TLS/private CA configuration | **Runtime verified** at `1b883b6`: actual private-CA TLS acceptance passes, including correction of the observed MySQL hostname defect. Unsupported client-certificate/servername configuration remains separate. |
| Lease/registration latency absent from budget | **Frozen `ea3cc83`:** actual PostgreSQL/MySQL lease samples separate first-session persistence, reused-session acknowledgment and retained leases; documented request arithmetic accounts for read/freeze deadlines. Local overhead excludes guardian IPC, TLS and remote network. This addresses missing mechanism/cost accounting without claiming managed-server capacity or weakening ownership checks. |
| Historical red CI omitted | **Disclosure improved; historical causes not all proved.** Keep exact failed checkpoints separate from newer passes. |
| PostgreSQL 18.6 versus pinned 17.11 | **Corrected documentation/evidence scope.** Native and pinned-image runs are separately identified; neither proves the other version. |

## Accepted runtime and transfer checkpoint before this review wave

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

Each fix needs an exact pushed commit, focused evidence appropriate to failure cost, and integration review. A runtime implementation alone does not close a lower-stack obligation; use the composed lower hashes above and their actual acceptance. Recheck GitHub heads and any new reviews before posting a response; do not mark all review comments resolved from this checklist. Current runtime, real-board and image acceptance is recorded above; transfer and remaining per-finding obligations remain in the build plan.
