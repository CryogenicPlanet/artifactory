# Database stack review status

Read this alongside the [build plan](build-plan.md). This is a triage checkpoint, not a claim that reviewers have resolved their comments. Latest verified pushed heads are #2 `576476f`, #3 `c4e4bd2`, #4 `ef47bba`, #7 `9089ba4`, and #8 `0bcc301`. Runtime integration is separate, at pushed `0cd267b`; draft [PR #9](https://github.com/CryogenicPlanet/artifactory/pull/9) CI ran `b9d6de4`. Subsequent worker commits require integration and verification before changing a status here. No tests were run for this audit.

**Statuses:** **pending** needs a fix, decision, evidence or disclosure; **already fixed** has evidence in the named pushed layer; **runtime-only** has implementation in the separate runtime checkout but does not resolve the lower PR; **disagreement** identifies a review premise that needs clarification rather than silently changing behavior.

## Review inventory

The full issue comments were read: [PR #2 review](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5644305395), [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307), and [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084). GitHub's paginated pull-request review and inline-comment endpoints were also queried for #2, #3, #4, #7 and #8. Each of #2–4 has one older formal review and no inline comments; #7/#8 have neither formal reviews nor inline comments at this checkpoint. This does not substitute for their separate issue-comment review work.

Older formal reviews: [#2](https://github.com/CryogenicPlanet/artifactory/pull/2#pullrequestreview-5180528233), [#3](https://github.com/CryogenicPlanet/artifactory/pull/3#pullrequestreview-5180528413), [#4](https://github.com/CryogenicPlanet/artifactory/pull/4#pullrequestreview-5180528628). Their still-relevant asks are included below. Parallel writers own the #2–4 fixes; this document does not supersede their scopes.

Incremental issue-comment and review-body refresh after 2026-09-12 06:59:22 UTC found no new comments on #2, #3, #4, #7, #8 or #9. Earlier full formal/inline inventory remains above.

Historical focused evidence: #2 had 11 passes; #3 had 25; #4 had 34 plus an overlapping 62-case core group; #7 had 49 schema passes. New terminal-refusal/copy-fixture/public-metadata corrections pass seven, eleven and one case respectively. PR #3 `c4e4bd2` now passes both Linux shards, image and QEMU. Other latest-head Linux and PR #9 board jobs are running; earlier greens do not accept those heads or close every finding.

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
| Editable migrations can destroy protected identity/recovery tables | **SQLite implemented; portable completion pending.** Protected migration-state checks are integrated on SQLite. PostgreSQL/MySQL protection is active isolated work, not integrated; this still overlaps base item 48. |
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

## Runtime acceptance remains open

Native PostgreSQL 18.6 completed authentication, write/replay, backup, restore, restart and subsequent writes at worker `795c738`. Pinned PostgreSQL 17.11 image acceptance is separate. The paired MySQL loader/operator grant corrections are pushed in `0cd267b`, with check/build passing. The saved-board retry then failed during outstanding rollback with generic `remote_database_provision_failed`, before a new flow. Process/inventory closure is proved and failed targets remain preserved; safe operation-stage diagnostics are in progress. No complete MySQL board pass is claimed. The latest runtime full suite has not run; `b9d6de4` CI's 929 passes, nine failures and 51 skips remain historical evidence.

The MySQL session-metadata `GRANT OPTION` claim is corrected: account-filtered `session_account_connect_attrs` is world-readable on MySQL 8.4, confirmed by 2/2 native ACL tests. Redundant grants were removed by `d16f53a`/`745abf5`, integrated as `c072c7e`/`4dda191`; other provisioning and XA privileges remain necessary. Portable migration protection, advanced stored-object/direct-DDL decisions, and final board/image/full-suite acceptance remain open. Cross-engine transfer is unimplemented.

## Acceptance before closing findings

Each fix needs an exact pushed commit, focused evidence appropriate to failure cost, and integration review. Runtime-only implementations do not close lower-stack comments. Recheck GitHub heads and any new reviews before posting a response; do not mark all review comments resolved from this checklist. The separate remote-runtime, real-board, image and transfer acceptance gaps remain in the build plan.
