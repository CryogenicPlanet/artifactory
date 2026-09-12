# Database stack review status

Read this alongside the [build plan](build-plan.md). This is a triage checkpoint, not a claim that reviewers have resolved their comments. Latest verified pushed heads are #2 `576476f`, #3 `c4e4bd2`, #4 `ef47bba`, #7 `6f86e49`, #8 `24cc343` and runtime #9 `709ae2c`; local test-anchor correction is `a9c9e33`. Current PR #7/#8 review inspection compares those heads with runtime `709ae2c`. Earlier #2–4 statuses below remain scoped to their named fixes. Subsequent worker commits require integration and verification before changing a status here. No tests were run for this audit.

**Statuses:** **pending** needs a fix, decision, evidence or disclosure; **already fixed** has evidence in the named pushed layer; **runtime-only** has implementation in the separate runtime checkout but does not resolve the lower PR; **disagreement** identifies a review premise that needs clarification rather than silently changing behavior.

## Review inventory

The full issue comments were read: [PR #2 review](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5644305395), [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307), and [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084). At the earlier inventory checkpoint, GitHub's paginated pull-request review and inline-comment endpoints were also queried for #2, #3, #4, #7 and #8. Each of #2–4 has one older formal review and no inline comments; #7/#8 have neither formal reviews nor inline comments at that checkpoint. This does not substitute for their separate issue-comment review work.

Older formal reviews: [#2](https://github.com/CryogenicPlanet/artifactory/pull/2#pullrequestreview-5180528233), [#3](https://github.com/CryogenicPlanet/artifactory/pull/3#pullrequestreview-5180528413), [#4](https://github.com/CryogenicPlanet/artifactory/pull/4#pullrequestreview-5180528628). Their still-relevant asks are included below. Parallel writers own the #2–4 fixes; this document does not supersede their scopes.

An earlier incremental issue-comment and review-body refresh after 2026-09-12 06:59:22 UTC found no new comments on #2, #3, #4, #7, #8 or #9 at the time. That issue-comment inventory is superseded by the complete PR #7/#8 reviews below; the earlier formal/inline inventory remains historical evidence.

Historical focused evidence: #2 had 11 passes; #3 had 25; #4 had 34 plus an overlapping 62-case core group; #7 had 49 schema passes. New terminal-refusal/copy-fixture/public-metadata corrections pass seven, eleven and one case respectively. PR #3 `c4e4bd2` now passes both Linux shards, image and QEMU. Current PR #7/#8 heads pass all checks. PR #9 `709ae2c` passes both actual-board jobs, remote-driver checks, image and QEMU; its Linux shards remain pending. These results do not close every finding.

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
| URL scrubbing and three credential boundaries | **Runtime-only, partial.** `log-redaction.ts` exists, but separately audit read-worker stdin, the legacy alias and `COMMS_CHILD_CONFIG` decode/stderr paths. Do not equate descriptor parsing with complete leak prevention. The lower PR discloses deferral. |
| Remote alias form and retained-generation contract stamp | **Pending.** Runtime omits/refuses a remote alias; a per-generation contract stamp is not established. An implementation choice alone does not settle compatibility. |
| Mutable authoritative store pointer | **Runtime-only.** Remote identity selection persists `app_store_database` and updates target selection; verify restore/reopen ordering. SQLite's fixed descriptor does not prove the remote contract. |
| PR body names stale validation head | **Pending disclosure.** Update `d062269` validation wording to distinguish the reviewed `1ef641e` head, which includes two test-only commits after `d062269`; retain exact evidence. |
| Heading fixture repair predates descriptor work | **Already fixed as code; pending disclosure.** `d6509bf` fixes the stale `/init` assertion. State that it repairs an existing base fixture rather than claiming an untouched suite. |
| Fixture consolidation, including `:memory:` | **Pending.** Assign a bounded SQLite-preserving step and define in-memory fixture behavior before migrating further fixtures. Do not treat arbitrary quoted file counts as interchangeable. |
| Design list/path/error-code drift | **Pending documentation reconciliation.** Record mismatch code, actual package location and deferred methods; owner design files must not be overwritten by this audit. |
| New lint warning and tab-sensitive legacy fixture synthesis | **Lint already fixed** in `576476f` with `filterOrFail`; tab-sensitive fixture maintenance remains pending. Retain a loud failure if instrumentation no longer applies; do not weaken the compatibility scenario. |
| Keeper acceptance caveat | **Already available for PR #2 `576476f` as separate CI evidence.** Later stack heads need their own verification; ordinary unit tests alone do not execute the privileged image path. |

## PR #3: identity

All rows refer to the [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307).

| Finding | Status and next action |
| --- | --- |
| Ready adoption pins absolute path and breaks supported layout migration | **Already fixed** in `2ebc95e`: pending adoption remains path-bound; ready adoption uses UUID, with authenticated selected/recorded-location diagnostics and relocation coverage. |
| Identity refusal prevents journal recovery and disarms restore | **SQLite repair implemented; latest acceptance pending.** Reservation follows journal recovery, and opaque before-image preservation supports offline rollback. `c4e4bd2` corrects terminal startup-refusal observation. Do not extend this acceptance to remote missing/foreign-store repair without its own proof. |
| Abandoned `.restore-*` copies and early legacy stamps | **Already fixed** in #3: deterministic staging reclamation and completed-adoption-only, NULL-guarded legacy provenance. Legacy fixed-path residue was a distinct finding, fixed separately below. |
| Legacy `<store>.restore` residue remains forever | **Already fixed** in `2ebc95e`: known legacy staging and sidecars reclaimed after positive closure. |
| Foreign identity reported as missing; identity absent from diagnostics | **Partly fixed** in `2ebc95e`: `app_store_mismatch` differs from missing, and authenticated status exposes expected UUID/adoption/location. Showing both foreign/expected IDs and catalogue identity still needs explicit completion or decision. |
| Pre-upgrade refusal unreachable through HTTP | **Already fixed** in `2ebc95e`: permanent `boot_identity_upgrade_pending` HTTP 409 preserves old schema/journals. |
| Shape probe emits bare SQL errors and differs by adoption mode | **Already fixed** in `2ebc95e`: populated stores receive consistent shared-table shape probes with coded refusal. |
| Existing populated app store adopted under fresh boot state | **Partly fixed** in `2ebc95e`: shared outbox/batch high-water evidence ahead of boot refuses adoption. This does not prove freshness or discover domain rows after shared evidence has been pruned. |
| Editable migrations can destroy protected identity/recovery tables | **Integrated in runtime.** SQLite and portable protected migration-state checks now run at the named boundaries (`aae09da`, 25 focused cases). Trusted code must return for validation; explicit commits, independent connections and arbitrary executable dependencies remain outside this guard. New lower-layer receipt protection remains separate. |
| Same UUID does not prove freshness of a self-copy | **Already disclosed** in `2ebc95e` storage documentation: identity proves the board, not recency; use explicit restore rather than replacing same-UUID files. |
| Withdrawal status change omitted; failure reason remains empty | **Already fixed status invalidation; pending reason/disclosure.** `f4f1dca` clears stale live PID/port. Do not call a reasonless `starting` record an adequate diagnosis. |
| Historical Linux held-marker failures unexplained | **Pending historical explanation.** Later green exact-head CI establishes current execution, not the original failed phase/cause. Keep that distinction in the PR body. |

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
| Old ledgers show +38 lines and failed historical CI | **Disagreement about current status, pending clarity.** Those entries are explicitly historical and leading sections record newer acceptance. Preserve the old evidence, but label the rejected line-count estimate as superseded so it cannot be mistaken for a current measurement. |
| Schema rungs taken before unresolved base migrations | **Pending integration discipline.** Preserve IDs and validate complete histories/compatibility; a textual restack cannot establish migration correctness. |

## PR #7: complete ledger review

[Review 5644472625](https://github.com/CryogenicPlanet/artifactory/pull/7#issuecomment-5644472625) was read completely against lower `6f86e49` and runtime `709ae2c`. Preparation does not change the statuses below until integration/acceptance.

| Finding | Disposition |
| --- | --- |
| Ledger versus mirror authority | **Pending.** Valid ledger-ahead state still refuses. Writer is preparing validated-prefix recovery while retaining mirror-ahead/newer-schema refusal. |
| Repeated ladder ceilings | **Pending.** Derive targets from declared steps; partial shared boot constant does not remove literal core ceilings. |
| Historical adoption fixture built by current code | **Pending.** Independent historical v16/v18 artifacts and provenance are being prepared. |
| Missing boot post-adoption shape checks | **Pending.** Narrow transactional contract probes and historical comparison are being prepared. |
| `api.migrate` destroys bookkeeping | **Already fixed** in lower and runtime through migration-state preservation, with the documented trusted-code limits. |
| Raw SQL can delete editable `migrations` receipts | **Runtime-only fixed.** Lower backport `579be1e` is prepared, not integrated/test-accepted here. |
| Opaque corruption errors | **Pending.** Safe reason and expected/found identifiers are being prepared. |
| Successful no-op initialization lacks physical-byte test | **Pending.** Compare closed/checkpointed bytes after second initialization, not only logical snapshots. |
| Stable migration names / portability of ledger invariants | **Disagreement resolved by review itself.** Both allegations were explicitly refuted; no change required. |

## PR #8: complete dialect/remote-foundation review

[Review 5644467131](https://github.com/CryogenicPlanet/artifactory/pull/8#issuecomment-5644467131) was read completely against lower `24cc343` and runtime `709ae2c`.

| Finding | Disposition |
| --- | --- |
| Published JSON CASE casts/schema representation | **Pending design/code completion.** Current TEXT/LONGTEXT branches agree, so this is not a demonstrated parse blocker; native JSON schema and codecs/casts remain a substantive design obligation. Lower casts and runtime core JSON migration are in progress. |
| Main and KV snapshot helpers | **Runtime-only fixed.** Lower helper routing and per-boundary regression coverage are being prepared. |
| Remote dialect edge semantics unexecuted | **Pending.** Board/native SQL evidence improves coverage but does not replace the requested topic/tag/mention/dialect matrix; worker matrix remains isolated. |
| MySQL `incoming_seq` alias | **Unproven allegation.** A derived-table column is not automatically invalid. Run native move/collision tests before claiming a defect. |
| Public paths use SQLite descendants | **Runtime-only behavior fixed.** Lower remains open; obsolete helper/export cleanup is separate. |
| Null-safe event exclusion | **Runtime-only fixed** with `distinctFrom`; lower remains open. |
| GLOB/planner hints | **Runtime-only behavior fixed.** Unused helper cleanup is separate from the SQL correctness issue. |
| Singleton mutation/edit admission locks | **Runtime-only fixed** at allocator/lock boundaries; lower remains open. |
| Prefix rewrites use SQLite concatenation | **Runtime-only fixed** in events/public paths; lower remains open. |
| KV/system upserts invalid on MySQL | **Runtime-only named callers fixed.** Direct dialect branches suffice; do not invent a generic helper merely to match a proposed name. |
| MySQL REPEATABLE READ not asserted | **Pending correctness fix.** Prepared lease-admission assertion has not been integrated or natively accepted here. Nondefault server isolation can violate snapshot semantics. |
| URL redaction before persisted stderr | **Runtime-only fixed** at reviewed child/supervisor boundaries with scoped redaction and adversarial coverage. |
| TLS/private CA configuration | **Runtime substantially addressed.** Verified TLS/default and image trust-store contract exist; per-connection client certificates/servername are unsupported and private-CA acceptance remains unverified. |
| Lease/registration latency absent from budget | **Pending measurement.** Cost is per acquisition; transaction statements share a connection. Measure actual cutover before weakening ownership checks. |
| Historical red CI omitted | **Disclosure improved; historical causes not all proved.** Keep exact failed checkpoints separate from newer passes. |
| PostgreSQL 18.6 versus pinned 17.11 | **Corrected documentation/evidence scope.** Native and pinned-image runs are separately identified; neither proves the other version. |

## Runtime acceptance checkpoint

Runtime `709ae2c` passes both actual PostgreSQL/MySQL board CI jobs, remote CI, image and QEMU; Linux shards remain pending. Native PostgreSQL 18.6 full flow passed at `795c738`; native MySQL 8.4.11 full flow, interrupted rollback, second backup and closure passed at `048332f`.

Local runtime full suite at exact `709ae2c`: **1,019 passed, one failed, 59 skipped (1,079)**; **231 passed files, one failed, 24 skipped (256)** in **655.69s**, actual Node 22.22.3, max two workers. Stale preparation-phase instrumentation is corrected at `a9c9e33`; its exact-case rerun is still pending. This is not a green combined run.

The new ledger/isolation/read/JSON fixes above remain prepared or active, not integrated. Transfer codecs/storage are unintegrated with five codec/seven SQLite passes and no native run; no transfer CLI, copy or marker workflow exists. Advanced-object/direct-DDL decisions and final combined review remain open. MySQL metadata ACL advice is corrected; no redundant grant or grant-option requirement exists for its account-filtered world-readable session metadata.

## Acceptance before closing findings

Each fix needs an exact pushed commit, focused evidence appropriate to failure cost, and integration review. Runtime-only implementations do not close lower-stack comments. Recheck GitHub heads and any new reviews before posting a response; do not mark all review comments resolved from this checklist. The separate remote-runtime, real-board, image and transfer acceptance gaps remain in the build plan.
