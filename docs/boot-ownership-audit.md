# Boot ownership audit

Original audited production checkpoint: `a834e3f`; ownership implementation is at `2ee17ac`, followed by test correction `39e0bd0`, owner decision record `1013524`, stream fixture `7064136` and health-timeout fix `23b9be5`. This is an ownership review, not a line-count target. Implemented changes and remaining proposals are distinguished below. The owner's current direction is to remove convenience responsibilities from boot. Older feature requirements are identified explicitly where that direction changes them.

Owner clarification after this audit: boot retains source version inspection and safe revert, not only generation fallback. Its public dead-app event surface is for boot lifecycle/failure diagnostics only. Application event browsing belongs to the editable app; internal publication evidence remains protected. These decisions supersede the undecided event/history recommendations below. Diagnostic separation, telemetry removal and conditional raw source writes are now integrated. Historical local acceptance and the latest focused fixes are distinguished below; new-head combined/CI acceptance remains pending.

## Boundary

Boot owns the trusted machinery needed to repair broken editable code without losing data or exposing authority: the listener and credential boundary; process closure and admission; source publication and generation selection; database recovery; and the durable evidence those operations use. A feature being useful while the app is down is not, by itself, sufficient justification.

The current design also deliberately places all credentials and the general event store in boot. That is broader than a process bootloader. SPEC §§4.3 and 6.1 require it. This audit distinguishes those security/product contracts from intrinsic recovery needs instead of calling every existing feature essential.

## Implemented changes and remaining proposals

| Responsibility | Implementation status / remaining proposal | Retained boundary or contract change |
| --- | --- | --- |
| App tracing annotation aggregation | Implemented in `dd3c6e7`: removed child annotation parsing/aggregation. App owns interpretation and export of its spans. | Keep boot's bounded request record, verified identity, request ID, redaction and stripping of private headers. This narrows docs/tech §8's single aggregated wide event. |
| Prometheus registry, histograms and text formatting | Implemented in `dd3c6e7`: optional boot scrape/registry/instrumentation removed; presentation belongs in editable tooling. | Preserve operational status and explicit lifecycle events. Do not add a new privileged telemetry protocol simply to preserve historical counters. The former metrics requirement is intentionally narrowed. |
| Anchored string replacement | Implemented in `ba5866b`: anchored routes return 405; caller tooling edits bytes using conditional raw PUT/DELETE. | GET exposes a content token and quoted ETag. Raw writes accept exact If-Match or If-None-Match: *; comparison and staging/publication share the source gate. Preserve locks, path checks, modes and atomic publication. Changes SPEC §§6 and 7.5's anchored-edit API. |
| Initial page content deployment | Investigated; intentionally unchanged. The boot-owned one-time marker protects deleted/restored page data. Moving content initialization safely would require a new launch protocol, which is not part of this slice. | Preserve existing `pages_seeded` evidence, never recreate deliberately deleted pages, and keep rehearsals from mutating live pages. Do not replace one boot coordinator with a general initialization framework. |
| Hourly age/type event deletion | Unimplemented proposal: remove boot's calendar policy in `event-retention.ts` while retaining independent physical-pressure reclamation in `event-storage.ts`. | This changes automatic 7/30-day deletion and its settings contract. SPEC §6.1 requires boot scheduling while §12 says retention policy belongs outside boot. Do not add a pruning API solely to retain an unnecessary convenience. |
| Generic Logger-to-event-store export | Unimplemented proposal: consider removing `log-events.ts`'s duplicate log sink. No recovery protocol uses those log rows as acceptance or closure evidence. | Keep sanitized stderr/status and explicit durable lifecycle records. Do not conflate this with removing failure evidence or redaction. |
| Separate manual token issuance | Unimplemented proposal: retire new issuance through `token-mint.ts`; enrollment already provides a human-approved issuance path with the app down. Do not move credential issuance into editable code. | Preserve existing families, refresh/revocation and outstanding exact mint replay outcomes. This intentionally removes SPEC §6's second issuance workflow; it is not deletion of identities. |
| Historical enrollment catalog | Optional account history, unlike the minimal family identifiers needed for revocation. Remove only if eliminating that product feature. | Existing account listings are already two plain SQL snapshots; there is no roster subsystem left to move. Preserve targeted credential management. |

## Responsibilities retained, and why

| Responsibility | Concrete justification |
| --- | --- |
| Authentication, passkey setup/login, enrollment, refresh, revocation and action proofs | The app must not receive credentials or be able to lock out its repair operator. Keep one usable issuance path and last-key protection. App account presentation is already outside boot. |
| Credential/header stripping and public admission | Editable code cannot set its own authentication floor. Public-page checks already use canonical paths and published grants rather than topic tables or rendering policy. |
| Keeper receipts, attempt identities, epochs and ownership closure | A stopped leader or missing route is not proof that an old writer can no longer modify data. These establish when replacement/reopening is safe. |
| Freeze/drain, candidate health, acceptance and fallback | These must remain available when an edit fails. Accepted writes must never be replaced by a pre-acceptance safety copy. Distinct cutover/restore ordering is not convenience duplication. |
| Source lock, staging, filesystem validation and publication journal | Repair must survive interruption and competing editors without publishing a partial tree or following unsafe paths. |
| Source version inspection, safe revert and retained generations | The owner explicitly retained the ability to inspect previous app/source state and revert it. Keep saved source, selectors and durable outcomes. Reset and source-only revert preserve messages, pages and identities; editing algorithms and elaborate presentation can remain outside boot. |
| Consistent backup, closure-gated restore and backup selection metadata | Restore must work without the app. A catalog is needed to identify the selected recovery artifact; rendering a backup dashboard is not. |
| Physical headroom and protected-artifact reclamation | A full store must not prevent authentication or recovery. Open attempts and active recovery artifacts cannot be deleted. Moving the existing selector alone would need a new deletion protocol and a dead-app reclamation replacement. |
| Sequence reservation, append/replay, publication fence and abort reconciliation | These protect acknowledged publication and cursor identity across app crashes and database restore. Unpublished evidence and receipts must survive payload pruning. |
| Minimal bounded boot request/failure diagnostics | The app cannot report requests rejected by boot or explain why recovery is unavailable. This is an explicitly retained diagnostic surface, not permission for boot to interpret product telemetry. |
| Immutable recovery manifest/help | Recovery instructions must remain usable with no working app. The integrated discovery change removes live response rewriting and directs callers to editable `/api` for the running application. |

## Broader contracts that are not intrinsic recovery requirements

- **Rich event queries and swap-independent long-poll:** the owner now chooses app-owned application event browsing. Public boot reads expose boot lifecycle/failure diagnostics only. Preserve a protected internal publication/read boundary for the app without exposing general browsing as a dead-app product.
- **Topic moves inside event append:** `events.ts` recognizes `topic.moved`, validates topic paths, rewrites historical `events.topic`, and updates public grants. The grant update protects anonymous admission; rewriting historical topic indexes is product semantics explicitly retained by SPEC §§6 and 12. The absence of app table imports does not make this domain-neutral. Removing it needs an app-owned interpretation of historical topic identity, not a generic privileged SQL escape hatch.
- **Source history and revert:** the owner explicitly retained inspection of prior source state and safe revert. Do not use the earlier ambiguity about “rich undo” to remove those capabilities. Rich presentation and text processing are separate convenience responsibilities.
- **Retention defaults and arbitrary public-route exceptions:** signed settings protect authority, but that does not make every configurable policy essential. Preserve the safety floor and existing data; handle retirement of supported settings explicitly.

## Current slice and remaining decisions

Integrated: public `/_boot/events` is a human/fs-only lifecycle/failure reader using trusted NULL transaction provenance, only since/limit parameters and a separate allocated-sequence diagnostic cursor. Pending app publication cannot hide boot failure diagnostics. Its `current_failure` is the generation row’s current bounded/redacted detail, not immutable historical stderr. App-owned `/api/events` provides rich queries/waiting. Internal append/query evidence and private filter/wait compatibility remain protected for retained snapshots. This preserves internal consumers, not every old public route: snapshots predating app-owned `/api/events` need an editable route update to supply that feed after fallback. Safe startup, messages and source repair remain preserved.

Prometheus presentation and child-span aggregation are removed; minimal boot diagnostics, request identity and private-header stripping remain. Conditional raw writes replace anchored editing while preserving locks, modes, source version inspection and safe revert. Live discovery composition and obsolete selector-only undo cleanup were already integrated. Lifecycle consolidation is implementation cleanup, not itself a scope reduction.

Complete combined and exact-head CI acceptance after the latest health-timeout fix; the earlier local full pass does not accept newer production changes. Page seeding remains deliberately unchanged. Optional calendar deletion, generic log mirroring, manual token issuance and catalog retirement remain audit proposals with compatibility requirements, not blockers to this slice or implemented removals. No source history, credentials or recovery evidence may be discarded to make boot smaller.

## Evidence

- `packages/boot/src/index.ts`: installed service graph and background maintenance.
- `packages/boot/src/route-discovery.ts`: immutable public surface inventory.
- `packages/boot/src/request-events.ts`, `proxy.ts`, `log-events.ts`: retained diagnostics/header boundary; former metrics removal is in dd3c6e7.
- `packages/boot/src/source-files.ts`, `edit-http.ts`: conditional staging/publication and retired anchored routes.
- `packages/boot/src/application.ts:48`: page seed orchestration; `:97`: durable page seed marker.
- `packages/boot/src/event-retention.ts`, `event-storage.ts`: separate calendar and physical-pressure mechanisms.
- `packages/boot/src/events.ts:153`: explicit topic-move interpretation.
- `packages/boot/src/token-mint.ts`, `enrollment.ts`, `account-queries.ts`: duplicate issuance versus essential identity authority.
- `SPEC.md` §§4.3, 6–6.3, 7.5 and 12; `docs/tech.md` §8; `docs/pr-1/boot-audit.md`; `docs/pr-1/second-pass-5d96c1d.md`.

Three independent read-only audits covered authentication/settings/public admission; events/telemetry; and source/lifecycle/recovery. The lead inspected their boundaries against current code. A fresh review found no misleading event/telemetry claims. Separately, the integrated `a834e3f` baseline passed check and the full suite: 782 tests passed, one opt-in skipped, across 191 passing files and one skipped file, in 519.49 seconds with actual Node22.22.3 and two workers. This predates the newly authorized scope implementation.

Production `2ee17ac` build and combined fresh review pass. Corrected pushed root `39e0bd0` passes check and the full suite with actual Node 22.22.3 and two workers: **780 tests passed, one opt-in skipped**, across **190 passed files and one skipped file**, in **534.13 seconds**, exit 0 (`/tmp/comms-ownership-corrected-full.log`; check `/tmp/comms-ownership-corrected-check.log`). The earlier `2ee17ac` full run had 779 passed, one failed and one skipped in 544.12s: a custom orphan child lacked the moved public `/api/events` route after its closure/data assertions passed. The test-only correction verifies authoritative published-store event, batch and fence evidence; six focused cases pass and production is unchanged.

At `39e0bd0`, image and QEMU pass; Linux finished 779 passed, one failed and one skipped (781 tests). Shard 1 passes439; shard 2 has340 passed, one stream-fixture failure and one skipped. The canceled preceding Linux run also recorded one 15-second public-path policy fixture timeout without phase evidence. Its cause remains unknown; the 27 sequential subprocesses are an observation, not a diagnosis or a fix. Exact later CI results belong to the PR checks. These qualifications do not reopen already verified source-preservation guarantees or claim every remaining audit proposal is resolved.

Current root `23b9be5` includes owner commit `1013524` recording the scope decisions in SPEC/tech/review comments, without further edits to those documents here. The stream fixture now uses an explicit gate in `7064136` (15/15 focused tests). The production health-timeout retirement fix `23b9be5` passes 23/23 focused tests; its regression failed on the baseline with `frozen:true` and passes after proven-closure failure handling. Combined root check/build pass (`/tmp/comms-playable-check.log`, `/tmp/comms-playable-build.log`); new-head CI remains pending. No full-suite result after this production fix is claimed; the prior780-test local pass remains scoped to39e0bd0.
