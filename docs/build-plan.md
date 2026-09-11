# Build plan

The lead owns integration and acceptance. Writers use isolated checkouts; only the lead integrates into `codex/build-comms-core`. The owner-approved review and later decisions in SPEC §12 supersede older descriptive sections. Preserve the uncommitted owner files: `SPEC.md`, `docs/tech.md`, `docs/database.md`, and `docs/pr-1/`.

## Current base completion — second-pass review

The owner-requested [PR #1 second-pass review](https://github.com/CryogenicPlanet/artifactory/pull/1#issuecomment-5637214197), including items 25–31, controls current work. **Base first:** PRs #2–4 and prepared migration/remote-client work remain paused and unintegrated. Finishing this review precedes the rest of the build plan; no merge or deployment is implied.

Production is frozen at `e04bd03` for combined acceptance. The parent reports root check/build passing on that source. Integrated second-pass changes include mention punctuation and subtree-only marks, isolated extension conflicts and declared disabled errors, safe freeze finalizers and a 60-second admission queue, sampled storage admission, page publication waiting outside reservation gates, page/board errors and CSP, lowercase new enrollment labels with legacy identity preservation, retained installer downloads, protected extension tables, fresh-store retired-table removal, authenticated source repair after failed recovery, cooperative read deadlines with cleanup escalation, signal-driven drain/relevant-event waits, public subscription/capability boundaries and typed topic parameters. Guide corrections are prepared separately. Individual focused tests and reviews support these changes; they are not a final combined full-suite result.

**Latest completed full local suite:** `d9224e7`, actual Node 22.22.3 with two workers, 717 passed across 179 files in 514.26s (`/tmp/comms-base-final-full.log`), with one opt-in measurement skipped. That run predates this second-pass wave. A new full run at `e04bd03` is in progress at `/tmp/comms-second-pass-final-full.log`; do not infer its outcome from this checkpoint. Cutover measurement and the temporary two-agent workflow remain unrun.

**Latest reported Linux gap:** `bbb4da9` finished 716 passed, one failed and one skipped. The SQL fixture exceeded its 30-second aggregate while issuing 43 requests. Test-only `7e1501c` separates failure stress from bounded-query assertions, retains the same 30-second deadline, and passes its three focused cases. This does not establish the historical timeout's cause. The earlier `854e18c` first-message HTTP507 before QEMU reboot also remains unexplained; later green runs do not diagnose it. Final pushed-head Linux, image and QEMU acceptance remain required.

Fresh app stores no longer create retired reaction tables; existing historical data and receipts remain preserved. Legacy boot topic-move cleanup detects old tables only during startup compatibility, requires positive owner closure before reconciliation, and removes them only after proven completion. Ambiguous tree/receipt/partial-table evidence remains preserved and refuses with `409 topic_move_recovery_required`; ordinary live paths use app-owned moves. Final boot line/file counts await the parent's inventory after integration. The approximate 7,250-line target remains unmet; compatibility and recovery guarantees must not be deleted to meet it.

Readonly SQL uses scoped subprocess cancellation; synchronous SQL writes still rely on whole-child keeper/watchdog recovery. Cooperative read cleanup escalation is not a hard wall-time guarantee for arbitrary synchronous code. Request diagnostics remain intentionally lossy. Native installation/iOS and physical power-loss behavior remain untested; ordinary process-group closure excludes escaped/adversarial sessions. Do not claim every review comment is resolved.

The parent reports 18 current protected owner files. Preserve `SPEC.md`, `docs/tech.md`, `docs/database.md` and `docs/pr-1/`. The second-pass inventory `/tmp/comms-base-owner-hashes-second-pass.json` supplements original inventories; owner revisions are not agent edits. Older 16/17-file counts below describe their checkpoints, not today's file set. Original provenance and frozen handoff hashes remain historical evidence; never replace newer files with those snapshots.

## Integrated capabilities and retained contracts

| Group | Integrated work / remaining constraint | Retained acceptance boundary |
| --- | --- | --- |
| Boot errors | Exhaustive literal-code status/hint policy; route-named non-retriable defects and conservative mixed failures | Preserve shared handler interfaces; coordinate backup route with deployment |
| Human source undo | Undo through another editor's lock after active cutover finishes; revalidate session and preserve the other overlay | Reuse borrowed pin and exact durable acceptance; prove pre/post-acceptance restart and queued logout |
| Optional policies | Runnable deletion and profile/roster examples using public extension capabilities | No new core product routes; preserve tombstones, sole-author rules, publication and replay |
| UI contracts/SSE | Pure shared HttpApi, generated AtomHttpApi and scoped cursor/reconnect invalidation | Contract remains editable in standalone runtime; preserve nested-topic URLs, drafts and mark=0 |
| Rehearsal effects | Scoped outbound/timer helpers and actual bounded health suppression report | Coordinate extension API and cutover report propagation; no claim arbitrary native network is intercepted |
| Physical event quota | Event pages plus conservative shared freelist/WAL accounting; bounded checkpoint/reclaim | Coordinate fresh schema and settings; preserve recovery evidence and required terminal publication |
| Signed settings | Typed retention, budgets and exact public paths; proof binds patch/revision/session, replay returns first result | Fresh configured quota values; immutable recovery/auth floor and privileged-path exclusions |
| Deployment | Boot/app/build ownership, immutable keeper entry points, resumable layout conversion | Actual Linux permission/WAL/process tests; independently controlled real-reboot acceptance |
| Boot simplification | Remove concrete duplication and unnecessary ownership without weakening recovery | Reassess after correctness lanes; count real production changes, not relocation or formatting |
| Receipt retention | Bound terminal undo receipts without losing pending evidence or misrepresenting retained outcomes | Follow human-undo integration; explicit timestamps, legacy compatibility and replay window |

The original takeover handoffs, shared bootRoute/Origin policy, UI utility conversion and readonly SQL cancellation are integrated. Their earlier open-item lists are superseded. Structural boot reduction remains incomplete; record exact final counts with the next combined acceptance result.

An optional request-event roster must label activity as last observed, because diagnostic event loss prevents exact presence reporting. Boot token use continues to update at authentication. Preserve this distinction in example documentation and acceptance claims.

The SQL HTTP adapter remains a kernel route as explicitly listed in SPEC §6; core domain routes use public extension capabilities. Historical stack-review claims that restart, metrics, combined restore or the startup layer graph are absent are superseded by implementation. Its base-first sequencing objection remains controlling.

## Integration and acceptance sequence

1. Finish the final combined review and reconcile the numbered second-pass findings against actual current code, retaining explicit limitations.
2. Keep production frozen during combined acceptance. Complete check/build and the full retained suite with actual Node 22.22.3 and two workers; record exact results rather than adding focused-run totals.
3. Run the opt-in real-kernel cutover measurement and temporary two-agent onboarding/conversation/edit workflow. Inspect status/error/latency and acknowledged-data evidence; keep UI acceptance minimal.
4. Integrate reviewed documentation, preserve owner files, commit coherent verified changes to the existing base PR and inspect Linux, image and QEMU on that pushed head.
5. Report unresolved review/spec gaps and the final boot inventory honestly. Keep database-stack advancement paused until the base is finished.

Each writer supplies a commit or exact hashes, owned files, focused evidence and a fresh review. Worker evidence is not combined-checkout acceptance. Stage explicit paths; never reset, clean, stash or discard unrelated work.

## Final spec-conformance additions

These additions were integrated before the current second-pass wave. Their earlier focused/browser evidence does not substitute for final combined acceptance:

| Addition | Current integration and acceptance |
| --- | --- |
| System topic view | Shipped metadata-only extension mirrors selected events with durable cursor and existing idempotency; private request diagnostics excluded. Focused restart/privacy tests pass. Combined durability assertions preserve original rows while accounting for derived system messages; the earlier full suite passed. |
| PWA | Authenticated manifest/icons and runtime/Docker staging integrated. Chrome persistent-profile installability checks pass; no service worker or offline cache. Native installation and iOS have not been exercised. |
| Recovery UI | Signed lock breaking and source undo integrated. Immutable human-only recovery page remains usable with every retained child broken; compiled browser smoke restored the board. |
| Development page reload | Launcher-only authorized page revision polling integrated; real dev smoke covers edits, CSP, auth expiry and simulated BFCache lifecycle. Asset-only changes do not trigger document reload. |
| Reservation events | New reservations atomically emit one trailing diagnostic; app ranges and publication fences remain intact. Focused allocator/replay/overflow/retention tests pass. |
| SSE reference | Bounded browser example refreshes snapshots on restore and never rewinds the durable event cursor to restored message data. Executable mock validation passes. |
| Request tracing and Logger export | Scoped cross-process request spans, bounded annotations, Logger export and optional drain example are integrated. The optional drain uses the public event capability; its privacy/fixed-window tests pass. Earlier combined local and Linux acceptance passed. |

## Historical acceptance and paused stack checkpoints

These results apply only to the named commits; they do not accept the current second-pass source.

Base acceptance was green at `5d96c1d`: [Linux](https://github.com/CryogenicPlanet/artifactory/actions/runs/34606806535) check/build,712/712 tests across177files, image UID/WAL/closure/persistence, and [QEMU real guest-kernel recovery](https://github.com/CryogenicPlanet/artifactory/actions/runs/34606806574). ActualNode22.22.3/two workers per shard. Local production suite passed711/711 before the additional deterministic fixture test. Earlier failures and exact evidence remain in the scratchpad; their causes are not all established.

Local follow-up3c9bace passes check/build, fresh combined review and712/712 tests177files513.66s actualNode22.22.3/two workers. It removes48production lines through scoped fsync and row decoding, retains marker diagnostics and corrects the Linux hot-journal fixture after positive closure. Later diagnostic-only da7cb75 passes check and9/9 tests in both affected files20.88s; production code is unchanged. Exact updated Linux acceptance remains pending.

At that checkpoint the boot-size target and shared route/Origin policy were unresolved. The route policy was subsequently integrated; the size target remains unmet. Separate SQLite descriptor [draft PR#2](https://github.com/CryogenicPlanet/artifactory/pull/2), latesthead `e954e70`, passes716/716 local tests across179files with check/build and frozen standalone/legacy recovery. Exact-head [Linux716/716 plus image](https://github.com/CryogenicPlanet/artifactory/actions/runs/34610021635) and [QEMU](https://github.com/CryogenicPlanet/artifactory/actions/runs/34610021779) pass. The workflow now includes the three storage tests omitted by its first Linux run.

Durable identity adoption is [draft PR#3](https://github.com/CryogenicPlanet/artifactory/pull/3). Implementation `4ecf31c`, followed by workflow merge `10d3064`, passes local check/build and724/724 tests across180files. Exact-head image and real-kernel QEMU pass; [Linux](https://github.com/CryogenicPlanet/artifactory/actions/runs/34611752910) finishes722/724. Boot page-move and server accepted-reset fixtures did not reach their held markers; their early request results were hidden, so the original cause is unknown. Diagnostic-only head7d79b18 retains deadlines and all concurrency/crash assertions and passes724/724Linux tests; QEMU passes. Its image job hits a readonly hot-journal recovery error after verified keeper closure; the local base fixture correction permits one recovery read before unchanged readonly stability checks. Identity adoption cases all passed Linux. Unique private restore directories can remain after SIGKILL; automatic reclamation is not implemented.

The next isolated SQLite tranche `d9522da` on `10d3064` introduces descriptor-based DbOps, engine-tagged backup provenance and shared strict descendant matching. Fresh review/check/build and734/734 tests across181files pass483.16s with actualNode22.22.3/two workers. Foreign engines are refused before copy, preserved by retention and excluded from legacy SQLite identity stamping. This is local evidence; [draft PR#4](https://github.com/CryogenicPlanet/artifactory/pull/4) is pushed at2b3e365, additionally merging the PR3 diagnostic fixtures (check/21focusedtests pass). Linux34614609950 finishes732/734, with an unexplained restored-policy507 and a slow-body cutover aggregate timeout; response/phase diagnostics are in progress. Image and QEMU pass. Remote clients are a separate committed, unpushed building block, now paused; remote engines, portable migration replay and transfer remain unimplemented.

## Build completion after the base review

Database portability is explicitly a separate PR after base review work (item 23 and SPEC §12). It remains part of the broader goal.

| Order | Deliverable | Acceptance |
| --- | --- | --- |
| 1 | Audit remaining phases 0a, 1, 0b, 2, 3 and 4 against the revised spec | Real onboarding/conversation/edit loop, real-kernel cutover measurement, lifecycle/subscriptions/pages and mobile smoke; do not restore superseded watcher, boot SSE, atomic page moves or drills |
| 2 | Store descriptor, engine-neutral copy/restore/capacity, dialect SQL and both migration ladders | SQLite stays green; boot knows no app domain table; restore preserves closure and authoritative-store selection |
| 3 | PostgreSQL for both stores with separate roles | Pglite CI plus real-server concurrency/recovery, copied-data rehearsal, fresh-target restore and role isolation |
| 4 | MySQL for both stores with compensation | Container tests for nontransactional DDL, absent RETURNING/partial indexes, migration/restart/restore and publication |
| 5 | Board transfer between engines | Row-by-row transfer preserves identities/content/history and sequence rules; completion marker and source stamp enforce startup safety |

Read the owner's detailed `docs/database.md` and its reviews before that track. Never mix engines between stores, hand boot credentials to a child, or claim backend acceptance from SQL compilation alone.

### Database implementation constraints from design review

The first separate stacked PR should introduce SQLite descriptors only, with `@comms/storage` shared by immutable boot and the standalone editable runtime. The owner document's server re-export from boot cannot resolve in that runtime. Preserve `APP_DATABASE` as a derived compatibility alias for retained generations; the keeper validates both descriptors and rewrites both to the private rehearsal copy. Parsing does not create files, choose the authoritative store or move recovery earlier. Remote engines remain explicitly unsupported in this tranche.

Subsequent implementation must address these design gaps rather than silently following unsafe pseudocode:

- Keep target transfer incomplete until provisioning succeeds; retire the source before final target completion. Persist a resumable transfer identifier and phases.
- MySQL boot DDL needs per-step durable intent and postcondition recovery because its DDL is not transactional. App rehearsal does not protect boot migrations.
- Adopt legacy store identities only after closure and authoritative-store selection, through a durable resumable adoption record. Missing initialized stores must not become fresh databases; old backup adoption belongs inside authorized restore.
- Separate core and editable migration ledgers to avoid ID collisions. Preserve historical migration identity while explicitly supporting target dialect replay.
- Transfer rows using verified schema inventory, explicit codecs and foreign-key ordering. Migration ledgers alone do not enumerate data; generated search structures must be rebuilt and verified.

The concrete migration inventory at `d9522da` has boot IDs1–18, core IDs1–8, editable TypeScript migrations already containing ID1, and separate extension registration receipts. Preserve all four histories. SQLite ledger extraction is preserved as paused isolated work: validate complete contiguous IDs/names and the legacy version before adoption; atomically record the supported prefix, remaining DDL and compatibility mirror. Keep `PRAGMA user_version` so older images retain their newer-schema refusal. PostgreSQL replay then needs boot-owned app DDL, core JSON/search conversion and fresh editable-ledger creation before its outer transaction. Keep ordinary settings and encoded receipt/event text representations; blanket JSONB conversion would break existing strings/decoders. Keep event topics writable because topic moves update that projection separately from immutable event JSON. None of this inventory establishes implemented PostgreSQL startup.

Remote-driver review adds two concrete constraints. Pinned `@effect/sql-pg` and `@effect/sql-mysql2`4.0.0-rc.113 are compatible; direct dependencies must remain exact. Neither supplies asynchronous connection registration. Use a scoped guarded SqlClient acquirer and handshake attempt tags if implementing durable remote ownership; do not hand the raw client to application services. A separate inspector can authenticate as the app account, avoiding global MySQL process privileges. Observe tagged session disappearance after positive local closure; interruption, KILL success, stale numeric IDs or a replacement endpoint are not closure proof. Missing/truncated instrumentation and uncertain server identity must refuse recovery. Real server tests are required before this design is accepted.

MySQL CREATE/DROP privileges also cover databases. Its proposed wildcard scratch grants do not prove the document's claimed boundary. Prefer exact boot-created clone grants and state that the app can create/drop that exact owned name; do not claim table DDL privileges forbid database DDL. Provisioning/closure details remain unimplemented and require explicit negative permission tests.

Session absence is also insufficient when prepared transactions can survive disconnection. PostgreSQL can refuse configurations with prepared transactions enabled. MySQL needs a separate proof: after positive local closure and relevant remote-session absence, BOOT could run `XA RECOVER` and refuse any prepared transaction. This requires the sensitive global `XA_RECOVER_ADMIN` privilege for BOOT, can block a shared server because unrelated prepared transactions are visible, and must never log or automatically resolve unknown XIDs. No such privilege or backend support is implemented. Direct authoritative-server continuity or an external fencing contract remains necessary across restart/failover; server UUIDs and successful reconnects alone do not prove an old primary closed. These additional requirements are explicit design deviations to resolve before claiming remote recovery acceptance.

These are implementation constraints, not completed capabilities or edits to the owner's documents. Real PostgreSQL/MySQL server acceptance must prove roles, concurrent transactions, migration interruption and restore; compilation or an embedded substitute is insufficient.

## Safety contracts

Boot owns sequence allocation, the one outstanding app reservation and the publication fence. Domain changes, outbox evidence and retry outcome commit together. Publish the complete reserved batch before mutation success or successful replay. Reads establish a snapshot before capturing the fence and cannot expose unpublished updates.

Writers use the shared epoch-fenced transaction protocol. Abort only on confirmed rollback or absence; timeout, defects and mixed failure causes are not evidence. Uncertainty refuses mutation while authentication, status and safe source diagnostics remain available.

Source journals retain before/desired bytes and modes independently of staging. Recovery preserves external conflicts. Keeper receipts prove owned process-group closure; PIDs, disconnected sockets and timeouts do not. Previous-kernel identity is proof only under the validated boot-identity contract. Pre-acceptance failure may restore its safety copy; post-acceptance recovery preserves newer acknowledged writes.

Boot strips credentials and supplied identity headers and guards child control. Sensitive human actions bind fresh proof to canonical parameters. Invalid bearer credentials never fall back to cookies. Public grants cover exact containing directories, become visible with publication, and rebuild from the authoritative restored store before anonymous admission.

## Testing and reporting

Boot/auth/durability tests cover failures, concurrency, restart, real processes, ownership, lost writes and restore. Server tests focus on durable transactions, receipt migration/replay, snapshot visibility, schemas, authorization and cursors. UI acceptance is check/build and a few manual critical-flow and visual smokes; no blanket UI suite.

Run `bun run check` after code changes and relevant behavior tests. Close each combined wave with build and full retained tests. Repeat or broaden testing when changes, failures or unresolved concerns justify it. Report exact code, runtimes, worker count, totals and CI links; distinguish isolated evidence from integrated acceptance. Do not claim deployment, merge or full review resolution without evidence.
