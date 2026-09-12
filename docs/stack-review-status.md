# Database stack review status

Read this alongside the [build plan](build-plan.md). This is a triage checkpoint, not a claim that reviewers have resolved their comments. Code inspection used pushed PR heads #2 `1ef641e`, #3 `f4f1dca`, #4 `7d47607`, #7 `aaf6396`, #8 `686e07c`, and separate runtime integration `fe93647`. Subsequent worker commits require integration and verification before changing a status here. No tests were run for this audit.

**Statuses:** **pending** needs a fix, decision, evidence or disclosure; **already fixed** has evidence in the named pushed layer; **runtime-only** has implementation in the separate runtime checkout but does not resolve the lower PR; **disagreement** identifies a review premise that needs clarification rather than silently changing behavior.

## Review inventory

The full issue comments were read: [PR #2 review](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5644305395), [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307), and [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084). GitHub's paginated pull-request review and inline-comment endpoints were also queried for #2, #3, #4, #7 and #8. Each of #2–4 has one older formal review and no inline comments; #7/#8 have neither formal reviews nor inline comments at this checkpoint. This does not substitute for their separate issue-comment review work.

Older formal reviews: [#2](https://github.com/CryogenicPlanet/artifactory/pull/2#pullrequestreview-5180528233), [#3](https://github.com/CryogenicPlanet/artifactory/pull/3#pullrequestreview-5180528413), [#4](https://github.com/CryogenicPlanet/artifactory/pull/4#pullrequestreview-5180528628). Their still-relevant asks are included below. Parallel writers own the #2–4 fixes; this document does not supersede their scopes.

## PR #2: descriptors

All rows refer to the [PR #2 review](https://github.com/CryogenicPlanet/artifactory/pull/2#issuecomment-5644305395), including its smaller notes.

| Finding | Status and next action |
| --- | --- |
| Old boot cannot launch descriptor-aware installed code after image rollback | **Pending.** `BootChannel` still requires `APP_STORE` in the pushed layer and runtime. Derive it from a valid legacy alias when absent, retain conflicting-pair refusal and prove rollback compatibility. |
| `render` accepts paths its parser rejects | **Pending.** Align path validation/rendering and test control characters/backslashes before privileged spawn. |
| Server-to-boot import guard is too broad | **Pending.** `check-invariants.ts` still permits the entire package direction; restrict the actual launcher exception and test the boundary. |
| Errors omit variable names; relative `DATA_DIR` is unresolved | **Pending.** Normalize selection and add safe variable-specific diagnostics without exposing values. |
| Descriptor-only and mismatched pairs lack real child acceptance | **Pending.** Add both launch cases, including refusal before serving. |
| `render` must return `Redacted` | **Already fixed** in #2; the wrapper and its secrecy assertion are present. |
| URL scrubbing and three credential boundaries | **Runtime-only, partial.** `log-redaction.ts` exists, but separately audit read-worker stdin, the legacy alias and `COMMS_CHILD_CONFIG` decode/stderr paths. Do not equate descriptor parsing with complete leak prevention. The lower PR discloses deferral. |
| Remote alias form and retained-generation contract stamp | **Pending.** Runtime omits/refuses a remote alias; a per-generation contract stamp is not established. An implementation choice alone does not settle compatibility. |
| Mutable authoritative store pointer | **Runtime-only.** Remote identity selection persists `app_store_database` and updates target selection; verify restore/reopen ordering. SQLite's fixed descriptor does not prove the remote contract. |
| PR body names stale validation head | **Pending disclosure.** Update `d062269` validation wording to distinguish the reviewed `1ef641e` head, which includes two test-only commits after `d062269`; retain exact evidence. |
| Heading fixture repair predates descriptor work | **Already fixed as code; pending disclosure.** `d6509bf` fixes the stale `/init` assertion. State that it repairs an existing base fixture rather than claiming an untouched suite. |
| Fixture consolidation, including `:memory:` | **Pending.** Assign a bounded SQLite-preserving step and define in-memory fixture behavior before migrating further fixtures. Do not treat arbitrary quoted file counts as interchangeable. |
| Design list/path/error-code drift | **Pending documentation reconciliation.** Record mismatch code, actual package location and deferred methods; owner design files must not be overwritten by this audit. |
| New lint warning and tab-sensitive legacy fixture synthesis | **Pending small cleanup.** Retain a loud failure if source instrumentation no longer applies; do not weaken the compatibility scenario. |
| Keeper acceptance caveat | **Already available as separate CI evidence.** Exact-head image/QEMU evidence is in the leading ledgers; ordinary unit tests alone do not execute the privileged image path. |

## PR #3: identity

All rows refer to the [PR #3 review](https://github.com/CryogenicPlanet/artifactory/pull/3#issuecomment-5644334307).

| Finding | Status and next action |
| --- | --- |
| Ready adoption pins absolute path and breaks supported layout migration | **Pending, blocker.** Both inspected layers still compare the saved filename unconditionally. Preserve pending-adoption binding, but verify board identity after an authorized ready-store relocation; expose selected versus recorded location safely. |
| Identity refusal prevents journal recovery and disarms restore | **Pending, major.** `reserveIdentity` still fails the owners block before coordinator/restore recovery. Reorder without permitting mutation from uncertain evidence, and prove actual human repair. |
| Abandoned `.restore-*` copies and early legacy stamps | **Already fixed** in #3: deterministic staging reclamation and completed-adoption-only, NULL-guarded legacy provenance. These do not resolve the separate old fixed-path residue below. |
| Legacy `<store>.restore` residue remains forever | **Pending.** Reclaim the known prior staging path and sidecars only after positive closure, with preservation tests. |
| Foreign identity reported as missing; identity absent from diagnostics | **Pending.** Distinguish missing/foreign stores and expose appropriate authenticated identity/adoption metadata and backup provenance. |
| Pre-upgrade refusal unreachable through HTTP | **Pending.** Surface the permanent refusal accurately without migrating the store or returning a misleading generic retry hint. |
| Shape probe emits bare SQL errors and differs by adoption mode | **Pending.** Use a safe coded refusal consistently for invalid stores. |
| Existing populated app store adopted under fresh boot state | **Pending safety check.** Validate shared sequence/evidence high-water state before adoption; do not query app domain tables from boot merely to implement the suggested one-line fix. |
| Editable migrations can destroy protected identity/recovery tables | **Pending; overlaps base item 48.** Mediated raw-SQL protection does not establish arbitrary migration protection. Preserve recovery and test the actual extension/migration boundary. |
| Same UUID does not prove freshness of a self-copy | **Pending disclosure.** Identity verifies the board, not its version; stale same-board copies require explicit selection/recovery semantics. |
| Withdrawal status change omitted; failure reason remains empty | **Already fixed status invalidation; pending reason/disclosure.** `f4f1dca` clears stale live PID/port. Do not call a reasonless `starting` record an adequate diagnosis. |
| Historical Linux held-marker failures unexplained | **Pending historical explanation.** Later green exact-head CI establishes current execution, not the original failed phase/cause. Keep that distinction in the PR body. |

## PR #4: backup operations

All rows refer to the [PR #4 review](https://github.com/CryogenicPlanet/artifactory/pull/4#issuecomment-5644329084).

| Finding | Status and next action |
| --- | --- |
| Rung 18 skips the v17 pending-recovery upgrade guard | **Pending, major.** Both inspected SQLite schemas still use `< 17`; extend the guard with pre-migration v17 crash-journal coverage and old-image compatibility. |
| Step-2 API/copy budgets are absent or undisclosed | **Pending, partial runtime work.** Enumerate actual deferred operations and ownership rather than add inert wrappers. Remote copy has a budget, but SQLite rehearsal copy is still unbounded while hourly capture has a 10s aggregate. Define/test one coherent copy boundary. Reconcile `restoreInto` returning void versus the promised resulting descriptor, and prove the journal selects the intended store before/after restore. |
| Backup inserts and capture response omit engine | **Runtime-only.** Runtime names `engine` on all three inserts. Compose and verify explicit provenance plus capture-response schema in #4; its pushed SQLite layer still relies on defaults. |
| Rollback fabricates SQLite engine | **Runtime-only.** Runtime forwards `backup.engine`; lower #4 still needs the correction and foreign-engine refusal coverage. |
| Foreign-engine rows consume an unprunable budget | **Pending.** The inspected retention code still counts every row but excludes non-SQLite deletion. Choose and document a preservation-safe policy; do not silently delete foreign backups. |
| Artifact naming bypasses `backupPath` and lacks engine parameter | **Pending.** Runtime still uses a `.db` helper and mixed caller construction. Unify actual naming/validation/retention before changing suffixes. |
| Descendant helper belongs in dialect tranche; one statement mixes forms | **Pending scope decision; runtime-only conversion.** Portability work exists separately, but that does not remove the helper from #4 or verify all callers. Complete literal-prefix semantics and non-ASCII behavior tests in its intended layer. |
| Image/Linux/QEMU acceptance missing; production delta claim wrong | **Already fixed** at pushed `7d47607`, as acknowledged by the new review. Do not substitute the separate 848-test/8-skip run for this PR's own result. |
| Old ledgers show +38 lines and failed historical CI | **Disagreement about current status, pending clarity.** Those entries are explicitly historical and leading sections record newer acceptance. Preserve the old evidence, but label the rejected line-count estimate as superseded so it cannot be mistaken for a current measurement. |
| Schema rungs taken before unresolved base migrations | **Pending integration discipline.** Preserve IDs and validate complete histories/compatibility; a textual restack cannot establish migration correctness. |

## Acceptance before closing findings

Each fix needs an exact pushed commit, focused evidence appropriate to failure cost, and integration review. Runtime-only implementations do not close lower-stack comments. Recheck GitHub heads and any new reviews before posting a response; do not mark all review comments resolved from this checklist. The separate remote-runtime, real-board, image and transfer acceptance gaps remain in the build plan.
