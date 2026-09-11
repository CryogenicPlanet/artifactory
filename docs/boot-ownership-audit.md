# Boot ownership audit

Audited production checkpoint: `a834e3f`. This is an ownership review, not a line-count target or a claim that the removals below are implemented. The owner's current direction is to remove convenience responsibilities from boot. Older feature requirements are identified explicitly where that direction changes them.

Owner clarification after this audit: boot retains source version inspection and safe revert, not only generation fallback. Its public dead-app event surface is for boot lifecycle/failure diagnostics only. Application event browsing belongs to the editable app; internal publication evidence remains protected. These decisions supersede the undecided event/history recommendations below. Implementation of diagnostic separation and convenience telemetry removal is underway in isolated checkouts; neither is claimed integrated yet.

## Boundary

Boot owns the trusted machinery needed to repair broken editable code without losing data or exposing authority: the listener and credential boundary; process closure and admission; source publication and generation selection; database recovery; and the durable evidence those operations use. A feature being useful while the app is down is not, by itself, sufficient justification.

The current design also deliberately places all credentials and the general event store in boot. That is broader than a process bootloader. SPEC §§4.3 and 6.1 require it. This audit distinguishes those security/product contracts from intrinsic recovery needs instead of calling every existing feature essential.

## Convenience responsibilities to remove or move

| Responsibility still in boot | Finding and recommended disposition | Required boundary or contract change |
| --- | --- | --- |
| App tracing annotation aggregation | Remove parsing of child topic/message/extension annotations from `request-events.ts` and `proxy.ts`. App owns interpretation and export of its spans. | Keep boot's bounded request record, verified identity, request ID, redaction and stripping of private headers. This narrows docs/tech §8's single aggregated wide event. |
| Prometheus registry, histograms and text formatting | Remove the optional boot scrape feature in `metrics.ts`; presentation belongs in editable tooling. Recovery does not consume these counters. | Preserve operational status and explicit lifecycle events. Do not add a new privileged telemetry protocol simply to preserve historical counters. The former metrics requirement is intentionally narrowed. |
| Anchored string replacement | Move the algorithm in `SourceFiles.edit` to caller tooling. Boot needs safe conditional byte replacement, not an agent-native text editing tool. | GET already exposes a content token and internal `stage` supports it, but HTTP PUT currently does not pass it. Expose strict compare-and-set on raw writes before retiring the anchored route. Preserve locks, path checks, modes and atomic publication. Changes SPEC §§6 and 7.5's anchored-edit API. |
| Initial page content deployment | Move `application.ts`'s `seedPages` content bootstrap into the app. Boot may create/protect the page root; selecting and copying onboarding/product content is not generation recovery. | Preserve existing `pages_seeded` evidence, never recreate deliberately deleted pages, and keep rehearsals from mutating live pages. Do not replace one boot coordinator with a general initialization framework. |
| Hourly age/type event deletion | Remove boot's calendar policy in `event-retention.ts` while retaining independent physical-pressure reclamation in `event-storage.ts`. | This changes automatic 7/30-day deletion and its settings contract. SPEC §6.1 requires boot scheduling while §12 says retention policy belongs outside boot. Do not add a pruning API solely to retain an unnecessary convenience. |
| Generic Logger-to-event-store export | Consider removing `log-events.ts`'s duplicate log sink. No recovery protocol uses those log rows as acceptance or closure evidence. | Keep sanitized stderr/status and explicit durable lifecycle records. Do not conflate this with removing failure evidence or redaction. |
| Separate manual token issuance | Retire new issuance through `token-mint.ts`; enrollment already provides a human-approved issuance path with the app down. Do not move credential issuance into editable code. | Preserve existing families, refresh/revocation and outstanding exact mint replay outcomes. This intentionally removes SPEC §6's second issuance workflow; it is not deletion of identities. |
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

## Execution order

1. Narrow public boot events to lifecycle/failure diagnostics while moving application event browsing to the editable server. In parallel remove child annotation aggregation and optional Prometheus presentation. Preserve internal publication, authorization and diagnostic evidence.
2. Move anchored editing after exposing conditional raw writes; move page content initialization only with a no-reseed migration boundary.
3. Retire optional calendar deletion/log mirroring and the duplicate token issuance workflow with explicit compatibility handling. Preserve receipts, credentials and physical-pressure protection.
4. Preserve source version inspection/revert as now explicitly confirmed. Do not weaken durability, credential isolation or dead-app repair to make implementations appear smaller.

Already integrated: live discovery composition moved to editable server; unused selector-only undo coordinator removed. Lifecycle consolidation is implementation cleanup, not a scope reduction. No other removal in this audit is claimed complete.

## Evidence

- `packages/boot/src/index.ts`: installed service graph and background maintenance.
- `packages/boot/src/route-discovery.ts`: immutable public surface inventory.
- `packages/boot/src/request-events.ts`, `metrics.ts`, `log-events.ts`: telemetry responsibilities.
- `packages/boot/src/source-files.ts:247`, `edit-http.ts:314`: conditional staging versus current HTTP anchored/raw routes.
- `packages/boot/src/application.ts:48`: page seed orchestration; `:97`: durable page seed marker.
- `packages/boot/src/event-retention.ts`, `event-storage.ts`: separate calendar and physical-pressure mechanisms.
- `packages/boot/src/events.ts:153`: explicit topic-move interpretation.
- `packages/boot/src/token-mint.ts`, `enrollment.ts`, `account-queries.ts`: duplicate issuance versus essential identity authority.
- `SPEC.md` §§4.3, 6–6.3, 7.5 and 12; `docs/tech.md` §8; `docs/pr-1/boot-audit.md`; `docs/pr-1/second-pass-5d96c1d.md`.

Three independent read-only audits covered authentication/settings/public admission; events/telemetry; and source/lifecycle/recovery. The lead inspected their boundaries against current code. A fresh review found no misleading event/telemetry claims. Separately, the integrated `a834e3f` baseline passed check and the full suite: 782 tests passed, one opt-in skipped, across 191 passing files and one skipped file, in 519.49 seconds with actual Node22.22.3 and two workers. This predates the newly authorized scope implementation.
