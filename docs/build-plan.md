# Build plan

The lead owns integration and acceptance. Workers make bounded changes in isolated copies; one writer owns the shared checkout. The owner-approved PR review supersedes the earlier feature-completion plan wherever they differ. [codex-scratchpad.md](codex-scratchpad.md) is the detailed requirement and validation ledger.

## Current state

**Active takeover from `51eef7a`:** all four frozen handoffs have verified manifests and are deliberately composed in root, preserving owner files. Additional reviewed work provides exact keyed source-undo receipts, ordinary app-descendant closure, scoped Effect UI reads and complete onboarding discovery. Root check/build and the final combined two-worker Node22.22.3 suite pass: **626/626 tests across 159 files**. Fresh combined review found no actionable findings. Checkpoint Linux CI timed out with incomplete results; two shards and immediate failure reporting now complete within the limit, with **623 passed and 3 failed**, followed by **621 passed and 11 failed** as slower execution exposed additional fixture races/budgets. Reviewed fixture corrections pass root check and **90/90 tests across ten files**. The next Linux run passed **642/643**, leaving one reproduced pre-freeze metrics wait; its bounded fixture correction is integrated. Final exact-root acceptance at `f8b4e6b` passes **643/643 tests across 159 files**, plus check; Linux subsequently passed **641/643**, with two setup-budget failures; bounded integration defaults and explicit setup corrections are being validated. The leading scratchpad section records exact counts and remaining gaps; older paragraphs below are historical.

The pushed head is `2979676`. Current uncommitted SSE/preparation/metrics and Linux fixture corrections pass check/build and **519/519 tests across 136 files** locally. The owner's direction check identifies unresolved architectural intent despite these passing tests: core must actually consume the public extension API, boot must lose the app-policy callback for page writes, and restore requests must queue with post-wait authentication. These corrections precede landing any further routes. File relocation alone does not complete extension ownership.

The subsequent corrected core, numeric schemas, actual HttpApi error encoding, terminal health and combined-restore integration is now in the checkout. Root check/build and 17 focused tests pass; fresh root review verifies actual public-capability consumption. Its full root suite remains pending. Page-policy removal, queuing and boot/auth corrections are being composed separately before the next acceptance run.

The branch provides passkey sign-in, agent enrollment/refresh, conversations, topics, pages, editable runtime generations, journaled source history, rehearsed reload/rollback, backup inventory and signed database restore. Extensions provide routes, lifecycle hooks, cron, data and webhook subscriptions. These existing capabilities do not establish completion of the review.

Review changes committed through `6c21a88`:

- Correct legacy migration, event-routing and source-history fixtures.
- Remove reactions from core services/routes/UI while preserving historical data and receipts.
- Remove source watching/automatic adoption, weekly backup drills and the storage dashboard/cache. This first cut removes 609 boot production lines. Source history/undo and hourly backups remain.
- Preserve authenticated committed-source diagnostics after unproven keeper closure and unresolved page publication; do not mutate locks, staging or recovery evidence during diagnostic GETs.
- Release failed restore/move request gates after removing unsafe routes and closing owners. A recoverable failure must not permanently leak admission gates.
- Add redacted startup diagnostics and a serial diagnostic step to Linux CI. Subsequent measured fixture-budget corrections use two Linux workers and leave production deadlines unchanged.

Lifecycle changes passed combined acceptance (393/393 tests across 103 files, plus check/build): reset consecutive startup failures after healthy activation, emit demotion events, and apply separate drain/backup/candidate-health deadlines. The drain timeout preserves admitted writes and returns typed retriable `freeze_timeout` after safe cleanup.

The earlier API, shared mutation protocol, typed HTTP validation, public-page projection/CSP, event indexes, signal-driven waits, 30-day receipts and UI simplification wave passed **454/454 tests across 121 files**, with locked install, check and build passing. Live browser acceptance passed the core board flows. The core mount in that wave did not establish public-API ownership of domain behavior. Subsequent signed-restart work also found additional shutdown edges involving stalled writes, hooks and unread responses; its reviewed isolated correction is not yet integrated.

The 115-path SQL/move/storage/backup integration is pushed in `2979676`. Its historical full run produced 498 passes and 17 failures, subsequently resolved with reviewed fixture corrections. The newer exact-root 519-test pass includes that wave and the uncommitted SSE/preparation/metrics integration. See the scratchpad for logs and remaining limits.

## Parallel groups and dependencies

| Group | Owned work | Integration dependency |
| --- | --- | --- |
| API | Minimal retained endpoints, SQL message search/mentions, automatic marks, considered-through cursors, onboarding/manifest/docs | Shares app schema v7 and zero-event marks with mutations; consumes typed validation |
| Mutation protocol | One writer protocol, compatible unified receipts, safe rollback/abort and durable publication | Complete v7 includes mentions migration; remove obsolete writers before dropping old receipt tables |
| HTTP contracts | Executed wire schemas, literal errors, exhaustive response policy, bounded request parsing | Retained handlers use these contracts; arbitrary defects remain non-retriable 500s |
| Extensions | Actual core route ownership, public operations/read/migration helpers, subscriptions using that API | Shared mutations and publication signals; domain layout cleanup follows integration |
| Publication | Cached/pinned fence, append acknowledgements, signal-driven waits, stream failure envelopes, indexed event filters | One signal/cache instance; boot schema v14 coordinated with public paths |
| Boot hardening | Maintenance finalization, diagnostic access, retry/demotion, drain deadlines and positive closure | Preserve restore/reload acceptance boundaries through all merges |
| Public pages | Exact-directory grants, atomic event projection, restoration rebuild, app-owned topic policy, CSP/assets | Boot v14; app activation and shared mutations; safe file-journal policy seam |
| UI | Component-scoped state, shared request lifecycle, actual Tailwind, minimal API clients | Consume reaction-free API afterimages; no UI test suite |
| Linux | Compare serial and parallel failures using redacted process evidence, then fix demonstrated causes | Exact pushed commit and pinned runtimes; do not infer Linux behavior from macOS |

Every handoff supplies exact before/after hashes and focused validation. The lead resolves shared schema changes as one migration, preserves unrelated files and obtains a fresh review before committing meaningful changes. Do not reset, clean, stash or discard another writer's changes.

## Remaining review work

The numbered checklist in the scratchpad is authoritative. In addition to completing the active groups above:

- Move the topic-move coordinator and re-runnable page moves into the app/extension; remove boot's ordinary-product request freeze. Boot retains event routing rewrites.
- Reduce boot's remaining product policies: agent roster, QR dependency, SSE, hourly scheduling and preparation-cache complexity. Preserve the edit loop, editable dependencies/UI builds, auth and recovery mechanisms.
- Add the retained missing capabilities: boot backup mechanism, signed restart, metrics and combined generation/database restore. Reconcile any remaining signed settings/reset or human-lock recovery requirements against the review before expanding scope.
- Enforce the reviewed storage limits: 5% headroom, 20% backup cap, protected five-generation pruning, physical event retention, and safe outbox/receipt retention. Do not prune live or recovery-referenced evidence to satisfy a quota.
- Finish durable operational events, bounded SQL execution, hung-child retirement and the concrete auth/startup/error simplifications. No generic helper or backend framework.
- Remove boot reads of app domain tables and enforce that boundary with a source check once the policy move is complete.
- Complete combined acceptance and Linux/container ownership, descendant closure and actual reboot verification. Database portability is a separate later design/PR.

The owner accepts that shell edits no longer auto-deploy or create watcher history, topic-page moves become re-runnable rather than atomic, a broken app scheduler can miss hourly backups, and app-owned SSE disconnects on replacement. Do not retain obsolete machinery to preserve those superseded guarantees.

The owner clarified reset semantics: **reset only editable source to seed; preserve messages, pages and identities**. Do not implement a database or identity wipe. Signed restart and the remaining core-domain ownership split are being implemented in isolated copies; combined source/database restore and source reset have separate bounded design work.

## Safety contracts

Boot owns sequence allocation, one outstanding app reservation and the publication fence. App domain changes, outbox evidence and retry outcome commit together. Publish the complete reserved batch before mutation success or successful retry replay. Reads establish an SQL snapshot before capturing their fence and must not expose unpublished updates.

All retained writers use the shared epoch-fenced transaction protocol. Abort only after confirmed rollback or confirmed absence; a timeout, a defect or a mixed failure cause is not rollback evidence. Recovery must preserve full failure causes. Missing/conflicting evidence refuses mutation while boot authentication, status and safe source diagnostics remain available.

Source staging and publication history remain durable. A source journal records before/desired bytes and modes; replay preserves conflicting external edits. Source diagnostics may inspect physical page files during unresolved page moves without claiming a consistent product transaction.

A keeper's durable attempt-bound receipt proves owner exit. PIDs, disconnected sockets and timeouts do not. Linux boot identity can prove a prior-kernel owner is gone only under the validated kernel-identity contract. Close owners before replacing the database. Pre-acceptance failure may restore its safety copy; post-acceptance recovery must preserve newer acknowledged writes.

Boot strips credentials and supplied identity headers, forwards only verified identity, and guards child control. Sensitive human actions bind fresh passkey proof to canonical parameters. Explicit invalid bearer credentials never fall back to cookies. Recovery fixes must not weaken these boundaries.

Public grants are exact containing-directory grants; parents do not implicitly expose child topics/assets. Grant/revoke must become visible with publication. Database replacement clears stale grants and rebuilds from the authoritative restored app before public admission. Ordinary unrelated publication must not make an already-public page return 503.

## Testing and evidence

| Area | Required effort |
| --- | --- |
| Boot/auth/recovery | Strong failure, concurrency, restart and real-process tests for ownership, lost writes, source recovery, restore and credentials |
| Server protocol/API | Focused durable mutation, receipt migration/replay, snapshot visibility, schema validation, authorization and cursor/wait behavior |
| UI | Check/build and a few manual critical-flow/visual smokes; no new UI test suite or styling snapshots |
| Packaging | Real Linux permission, process-tree, WAL, restart and restore evidence before claiming isolation |

Run `bun run check` after code changes and relevant tests for behavior. Close a combined wave with builds and a full retained suite; avoid broad reruns without a changed or unresolved concern.

Earlier recovery-wave browser/compiled acceptance tested stronger watcher/topic-page/SSE behavior that is now being removed. It is historical evidence, not acceptance for the final review changes. Latest exact test counts, failures and CI links belong in the scratchpad and PR body. No deployment, merge or full completion is claimed.
