# Codex scratchpad: remaining work after PR #1 review

This is the handoff and remaining-work ledger for Codex. Implementation resumed with explicit owner authorization after the review landed. This records integrated changes, active isolated work and remaining requirements; worker reports alone are not completion claims.

## Prior checkpoint and authoritative review

- Repository: `CryogenicPlanet/artifactory`; the old `CryogenicPlanet/comms` git remote redirects there.
- Branch: `codex/build-comms-core`.
- Pushed checkpoint: `181939b` — `Checkpoint restore, topic move and source watcher integration`.
- Draft PR: <https://github.com/CryogenicPlanet/artifactory/pull/1>.
- Owner-approved review and ranked requirements: <https://github.com/CryogenicPlanet/artifactory/pull/1#pullrequestreview-5175391307>.
- Read the current `SPEC.md`, `docs/tech.md`, and `docs/pr-1/` before changing a new area. The review supersedes the old feature-completion plan wherever they disagree. `docs/build-plan.md` still describes much of the pre-review implementation and needs reconciliation.
- The owner's uncommitted `SPEC.md`, `docs/tech.md`, and `docs/pr-1/` were deliberately excluded from my checkpoint. Preserve them; do not replace them with worker beforeimages.

The checkpoint includes signed database restore, whole-source generation restore, topic move coordination, typed source history and direct-source watching, plus earlier authentication, conversation, UI and extension work. Several of these mechanisms are now explicitly selected for removal or relocation. Do not finish the old plan blindly.

## Current integration and validation

The last pushed checkpoint above is historical. The following review changes are committed in `f2bec7b` (fixtures), `6e9a98e` (reactions) and `c6f2a14` (boot reduction and diagnostics):

- Six stale migration/event/page fixture corrections: 30 focused tests passed.
- Recovery diagnostics remain available after unproven keeper closure, without expiring locks or removing staging; mutations remain refused. Worker validation: 27 tests across four files, fresh review clear.
- Reactions removed from core routes, services, UI and docs. Existing database rows and legacy receipts remain intact for compatible migration. Worker validation: check/build and 25 tests across eight files, fresh review clear.
- First boot reduction removes watcher/auto-adoption, weekly backup drill and storage dashboard/cache: **609 fewer production lines**, 27 changed/deleted files. Hourly backups and source history/undo remain. Worker validation: check/build, 92 distinct retained tests across runs and fresh review clear.

Before the boot reduction was integrated, repository check/build passed and the full suite produced **402 passed, one failed (403 tests, 104 files)**. The remaining failure was `generation-revert.test.ts` initial readiness: child still `starting` after the fixture's 15-second deadline, before the edit under test. It is not yet diagnosed as a product failure or resource-pressure flake. After the reduction, check/build and all 22 focused integration tests across four files passed, including generation restore. No deadline was relaxed; the isolated rerun does not establish the original timeout cause. A fresh read-only integration review found no blockers.

Linux CI was actually run at `181939b`: [run 34567582863](https://github.com/CryogenicPlanet/artifactory/actions/runs/34567582863). Install/check/build passed; tests produced **306 passed, 101 failed**. Beyond known local failures, representative tests exhausted one-second startup polling or a five-second whole-test budget. Logs lack child diagnostics at timeout, so neither resource pressure nor lifecycle failure is established. Reproduce representative cases serially with redacted process/status diagnostics before changing deadlines. OS ownership, container execution, descendant closure and real reboot acceptance remain unverified.

Do not repeat the public-page retry workaround. Fix the production read path and remove the retry allowance when its replacement lands.

## Active parallel work and integration boundaries

All writers use isolated copies. The parent alone integrates frozen before/after manifests into this checkout and preserves owner-owned spec/review files.

| Lane | Scope / dependency |
| --- | --- |
| Minimal API | Items 1/4/22 and retained `.handle()` adapters; SQL message filtering, comma-list mentions, exclusive cursors, removal of inbox/digest/search/read/reactions endpoints. Shares complete app schema v7 with mutation lane. |
| HTTP types | Literal code schemas, exhaustive refusal policies, defect 500s, shared wire-schema validation and SQL read adapter. Coordinates retained adapters with minimal API. |
| Shared mutations | One transaction/reservation/outbox/receipt protocol; compatible unified receipt migration; all retained writers. No partial v7 migration may be integrated. |
| Extension capabilities/core | Real extension-owned core mount, route conflict rules, public read/write/event helpers and extension migrations. Subscriptions must become an example of the public API. |
| Boot failure finalization | Delta D1/item 24: release owned request freezes on every exit while ensuring uncertain children/stores are not served. |
| Boot diagnostic access | Delta D3: committed source read/browse/history should not require unrelated page-move completion; preserve mutation and recovery guards. |
| Boot lifecycle | Items 12/13: consecutive failures and demotion events; drain-only freeze deadline with bounded backup/health steps. |
| Boot event indexes | Item 14: type/actor/instance/level projections and indexed filtering/cursors. Additive boot v14 coordinated with later public-path projection. |
| UI simplification | Item 20: agreed state ownership and Tailwind, consuming the minimal API UI changes. No new UI tests. |
| Public-page boundary | Plan complete, implementation pending lifecycle/core interfaces: exact-directory public_paths, no inherited grants, publication-atomic updates, fail-closed rebuild on database replacement, app-owned listing/write policy, coordinated CSP/assets. |

Latest delta: [review comment](https://github.com/CryogenicPlanet/artifactory/pull/1#issuecomment-5630256395), local `docs/pr-1/delta-review.md`. D1 gate leaks are confirmed. D3's overbroad diagnostic gate is confirmed, but the proposed backup-restore trigger is not established. D5's claim that conflicting intents null authentication is contradicted by the actual `Effect.exit` boundary and authenticated recovery tests; preserve fail-closed mutation rather than changing recovery order on that premise.

Current frozen handoff pointers (temporary recovery aids, not durable artifacts):

```text
/tmp/comms-fixture-triage.cjIfRL/handoff
/var/folders/2j/z4115t_51pv7sxxrq1_j7_xh0000gn/T/comms-pages-triage-bzogjcbs/handoff
/var/folders/2j/z4115t_51pv7sxxrq1_j7_xh0000gn/T/comms-recovery-diagnostics-7qhns5dc-handoff
/var/folders/2j/z4115t_51pv7sxxrq1_j7_xh0000gn/T/comms-resume-reactions-6vxfoikl/handoff
/tmp/comms-boot-reduction.udCo3F-handoff
/tmp/comms-review-first-tests.log
/tmp/comms-reduction-root-check.log
/tmp/comms-reduction-root-tests.log
/tmp/comms-linux-run-34567582863.log
```

Older SQL, automatic-mark and extension-route attempts may be selectively reused by their current owners. They are not independently mergeable against the new shared mutation/API contracts.

## Ranked review checklist

Numbers match the owner's review. None of these is marked complete merely because an earlier worker implemented part of it.

| # | Remaining action |
| --- | --- |
| 1 | Automatic marks on authenticated message views, highest returned message seq, `mark=0` peeking; no agent `POST /api/read`. Avoid work/events for unchanged marks; preserve lifecycle/epoch safety. |
| 2 | Top-level extension routes; reserve boot paths, `/api`, `/api/ext`; later duplicate owner fails alone; core override allowed and logged; ownership discoverable. |
| 3 | Integrated locally: reactions removed from core API/services/UI/docs; historical data retained. Unified receipt migration still belongs to item 9. |
| 4 | Remove core inbox/digest/token-budget surfaces. Add `mentions`, `exclude_self`, `newest` to messages. Preserve the recipe's home-subtree **or** mention semantics. Digest becomes `examples/extensions/digest.ts`; use “pages” consistently. |
| 5 | Make declared HttpApi schemas execute through `.handle()`; streamed routes still use the same decoders. Remove duplicated body/query parsers and schema/OpenAPI drift. |
| 6 | Literal error-code schemas and exhaustive status/hint maps. Defects become non-retriable `500 handler_failed` naming the route; preserve actionable typed errors. |
| 7 | Small extension API exposing durable message/topic/event operations, `ctx.read(effect)` and extension migrations. Move messages/topics/search/profiles into `ext/core.ts`; keep the kernel focused on the durable protocol and loading. |
| 8 | Signal-driven message and boot-event long-polls. Once streaming starts, failures must still finish with the documented envelope. Retain heartbeat, cursor and drain semantics; stop 100 ms full-query loops. |
| 9 | One `mutate({ events, idempotency?, body })` owns relay, epoch, reservation, transaction, outbox, receipt and safe abort. Every retained writer uses it. Consolidate idempotency with compatible migration and lost-response behavior. |
| 10 | Cache/pin the publication fence and consume append acknowledgements. Preserve transaction-snapshot visibility; remove repetitive fence HTTP calls from idle waits. |
| 11 | Index unshipped outbox rows and implement safe outbox/receipt retention. Coordinate pruning with recovery evidence, reserved ranges, retries and backup restore; deleting acknowledged rows must not break replay/reconciliation. |
| 12 | Count consecutive startup failures, reset on healthy start, and emit `generation.failed` on demotion. |
| 13 | Apply the freeze budget to drain, with separate backup/go-to-health deadlines and typed retriable `freeze_timeout`. Preserve the pre-/post-acceptance rollback boundary. |
| 14 | Indexed boot event columns for type/actor/instance/topic/level. Topic alone is currently projected. Remove duplicate filtering and advance empty filtered cursors correctly. |
| 15 | Bound/interrupt SQL execution and detect/retire hung children. A query must not wedge the only app thread indefinitely; preserve positive closure before replacement. |
| 16 | Emit durable lock, fs and generation transitions in their owning transactions; do not discard transition results. |
| 17 | Fix public-page availability during pending publication/reload through the reviewed boot `public_paths` projection. Do not read app policy under the long-held operation gate or paper over it with retries in tests. |
| 18 | Send the agreed CSP on agent-authored pages and verify the header at the actual served boundary. |
| 19 | Apply the review's concrete simplifications: shared parsing where still needed, exhaustive errors, one startup layer graph, shared committed-refusal/auth primitives/IPC contract, and clear admission names. Preserve independent boot recovery availability and startup ordering. No generic helper framework. |
| 20 | Use the agreed UI state model (or explicitly reconcile the documented choice), deduplicate loads, adopt Tailwind in the UI and remove redundant handwritten CSS. **No new UI tests requested.** |
| 21 | Reduce boot to its six approved jobs; relocate/delete the policies and mechanisms listed below. Add missing restart/metrics/combined restore and the required storage limits. |
| 22 | Finish the minimal API: id-or-seq `:ref`, search as message `q`, archive through topic PUT, extension-owned deletion/profiles/roster. One exclusive-since cursor/envelope contract; topic snapshot uses `fence`. Fix manifest references/boot descriptors and hash only init text for its version. Rewrite `/init`, editing docs and recipes. |
| 23 | Database portability gets a separate design/PR after base work. For now avoid gratuitous SQLite-only syntax where an actually supported portable equivalent exists, and prevent boot from learning app table names. Do not start a DbOps/backend framework in this PR. |
| 24 | Release maintenance request gates on every exit without reopening unsafe app routing; demonstrate recovery after failure. Remove ordinary topic moves from boot rather than building permanent maintenance gating around product writes. Ranked above item 17 by the delta. |

## Boot reduction: exact scope to retain when planning item 21

Keep credential-stripping proxy and auth; sequence allocation/event storage; snapshot/rehearsal/swap/rollback with positive keeper closure; edit lock/staging/publication; recovery access. Keep kernel boot-ID proof, consistent copies on demand, boot SQL, headless token minting and HTTP database restore. Keep editable dependency/UI builds; do not bake away the project's edit loop.

Remove or relocate the backup drill, boot agent roster, storage allocation walker, generation-preparation artifact/cache complexity, volume watcher, QR dependency, boot SSE, atomic page-subtree rename and topic-move coordinator. The app/extension owns hourly scheduling; boot exposes the copy mechanism at `POST /_boot/db/backup`. Simplify account listings as requested. Public-page policy projects to boot's `public_paths`; boot must not query app domain tables. Add the domain-table CI guard.

The owner explicitly accepts these changed guarantees; reconcile their older spec paragraphs instead of silently keeping contradictory promises:

- Topic-page moves become re-runnable, not atomic.
- Shell source edits no longer deploy automatically or create watcher history.
- A broken app schedule can miss hourly backups.
- App swaps disconnect app-owned SSE; boot long-poll remains available.

Keep request diagnostics, but fix the mismatch: current logging observes forwarded child dispatches; the review specifically wants boot-handled failures and enrollment/auth traffic while the child is down. Avoid feed self-logging and never record credentials.

Storage still needs 5% headroom refusal, physical event retention, the 20% backup cap and protected five-generation pruning. The review explicitly keeps headroom/event protection enforceable while the app is dead, despite moving ordinary scheduling/policy out of boot. Protect current/recovery-referenced artifacts and retry/recovery evidence; do not delete protected data just to claim a quota.

Missing retained capabilities: signed boot restart, metrics, combined generation-plus-database restore, and any still-required signed settings/reset controls. Source undo's exact HTTP-outcome replay and human source recovery through another holder's lock also need a final conformance decision; the current selection-only replay must not be described as exact outcome replay.

## Execution order

1. Re-read owner decisions and current checkout; identify new review comments/deltas and preserve unrelated edits. Confirm what remains relevant among the isolated fixes. Do not automatically restart all old workers.
2. Establish the retained recovery baseline and correct its known failures. Keep a clear distinction between fixture updates and production fixes; record the actual full-suite result.
3. Follow review order with bounded parallel lanes: minimal API/removals; HttpApi/errors; shared mutation/extension capabilities. Coordinate shared schemas and `ext/core.ts` centrally; isolate writers. The shared mutation contract must settle before migrating every domain writer.
4. Then combine signal/fence/outbox work with boot correctness and reduction. UI can proceed independently once the API contracts stabilize. Enforce the accepted smaller scope instead of preserving sunk-cost code.
5. Run proportionate validation, update the PR with small coherent commits and current limitations, and reconcile the build plan/spec with the accepted behavior. No deployment or merge implied.

Use Node `22.22.3` at `/Users/cryogenicplanet/.vite-plus/js_runtime/node/22.22.3/bin/node` for local test consistency. Directory-sensitive shims selected Node 26 in temporary workers before. Local Bun was `1.4.0-canary.1+4924862cf`; CI pins published `1.4.0+34cbb9a40`. Verify current binaries, not just `bun --version`. In isolated builds, ensure `@comms/boot` resolves the isolated package: a prior acceptance run accidentally loaded root boot via symlinked workspace dependencies.

Testing remains risk-based: strong boot/auth/publication/recovery tests, focused server behavior tests, no new UI test suite, and no repeated broad test runs without a changed/failing concern. No process-global mutable state, speculative abstractions or new permanent packages merely to organize this cleanup. Never mark a slice done from a worker report alone.
