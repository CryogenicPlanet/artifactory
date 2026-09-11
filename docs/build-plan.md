# Build plan

The lead owns integration and acceptance. Writers use isolated checkouts; only the lead integrates into `codex/build-comms-core`. The owner-approved review and later decisions in SPEC §12 supersede older descriptive sections. Preserve the uncommitted owner files: `SPEC.md`, `docs/tech.md`, `docs/database.md`, and `docs/pr-1/`.

## Goal and verified baseline

The active owner request is to finish the PR #1 review changes, then complete the build plan against the spec. Passing tests alone do not establish either milestone.

Baseline code `fb72973`, followed by documentation checkpoint `f61b04a`, passes **643/643 tests in 159 files** locally under actual Node22.22.3 with two workers and in [Linux run 34591769316](https://github.com/CryogenicPlanet/artifactory/actions/runs/34591769316). Check, build and Linux serial startup diagnostics pass. All four frozen takeover handoffs were hash-verified and composed against newer code. Earlier acceptance history is recorded in [codex-scratchpad.md](codex-scratchpad.md).

The baseline provides passkeys, enrollment/refresh, conversations, topics, pages, extension routes and lifecycle, editable generations, journaled source history, rehearsed cutover/rollback, backups, signed database and combined restore, signed restart, source-only seed reset, metrics and onboarding discovery. Reset preserves messages, pages and identities. Keyed source undo retains the exact accepted outcome and cannot replay over newer edits. These capabilities do not imply that all review comments are resolved.

## Review completion wave

| Group | Work and acceptance | Dependencies |
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

Before this completion wave, boot was 10,719 production lines in 87 files; the new required mechanisms add code, the final implementation is 12,234 production lines across 99 TypeScript files. The review's approximate 7,250-line target is unmet. Most requested policy removals are implemented; the latest scout identified roughly 75–130 lines of further safe consolidation. Additional reduction requires a concrete ownership or coordination simplification, not deletion of safety checks to meet a number.

An optional request-event roster must label activity as last observed, because diagnostic event loss prevents exact presence reporting. Boot token use continues to update at authentication. Preserve this distinction in example documentation and acceptance claims.

## Integration and acceptance sequence

1. Integrate independently reviewed boot errors and human undo against the current checkout, preserving newer changes.
2. Compose optional extensions and shared UI contracts; validate frozen standalone packaging and a small manual browser smoke.
3. Compose rehearsal reporting, settings and physical quota with shared interfaces explicitly reviewed.
4. Integrate deployment ownership and legacy migration, then verify actual container permissions, process closure, WAL and interrupted recovery in Linux CI. A container restart is not a kernel reboot.
5. Complete bounded boot consolidation and receipt retention, then freshly review every numbered PR comment and remaining spec requirement.
6. Run check/build and the full retained suite under actual Node22.22.3 with two workers. Push coherent verified commits to the existing PR and inspect Linux for the exact code; record remaining gaps honestly.

Each writer supplies a commit or exact hashes, owned files, focused evidence and a fresh review. Worker evidence is not combined-checkout acceptance. Stage explicit paths; never reset, clean, stash or discard unrelated work.

## Final spec-conformance additions

The final source audit found these explicit requirements beyond the initial review handoffs. They are being completed before the separate database track:

| Addition | Current integration and acceptance |
| --- | --- |
| System topic view | Shipped metadata-only extension mirrors selected events with durable cursor and existing idempotency; private request diagnostics excluded. Focused restart/privacy tests pass. Combined durability assertions preserve original rows while accounting for derived system messages; the full suite passes. |
| PWA | Authenticated manifest/icons and runtime/Docker staging integrated. Chrome persistent-profile installability checks pass; no service worker or offline cache. Native installation and iOS have not been exercised. |
| Recovery UI | Signed lock breaking and source undo integrated. Immutable human-only recovery page remains usable with every retained child broken; compiled browser smoke restored the board. |
| Development page reload | Launcher-only authorized page revision polling integrated; real dev smoke covers edits, CSP, auth expiry and simulated BFCache lifecycle. Asset-only changes do not trigger document reload. |
| Reservation events | New reservations atomically emit one trailing diagnostic; app ranges and publication fences remain intact. Focused allocator/replay/overflow/retention tests pass. |
| SSE reference | Bounded browser example refreshes snapshots on restore and never rewinds the durable event cursor to restored message data. Executable mock validation passes. |
| Request tracing and Logger export | Scoped cross-process request spans, bounded annotations, Logger export and optional drain example are integrated. The optional drain uses the public event capability; its privacy/fixed-window tests pass. Final combined local acceptance passes; Linux acceptance remains pending. |

Full combined code `5b36d55` passes check/build and **711/711 tests across 177 files**,487.37s, actual Node22.22.3/two workers. The subsequent `640d9f6` is a reviewed QEMU probe-only correction preserving every prior message row while isolating user-topic counts. Actual Linux image/QEMU results remain required before deployment acceptance. Earlier failed runs and focused corrections are recorded in the scratchpad.

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

## Safety contracts

Boot owns sequence allocation, the one outstanding app reservation and the publication fence. Domain changes, outbox evidence and retry outcome commit together. Publish the complete reserved batch before mutation success or successful replay. Reads establish a snapshot before capturing the fence and cannot expose unpublished updates.

Writers use the shared epoch-fenced transaction protocol. Abort only on confirmed rollback or absence; timeout, defects and mixed failure causes are not evidence. Uncertainty refuses mutation while authentication, status and safe source diagnostics remain available.

Source journals retain before/desired bytes and modes independently of staging. Recovery preserves external conflicts. Keeper receipts prove owned process-group closure; PIDs, disconnected sockets and timeouts do not. Previous-kernel identity is proof only under the validated boot-identity contract. Pre-acceptance failure may restore its safety copy; post-acceptance recovery preserves newer acknowledged writes.

Boot strips credentials and supplied identity headers and guards child control. Sensitive human actions bind fresh proof to canonical parameters. Invalid bearer credentials never fall back to cookies. Public grants cover exact containing directories, become visible with publication, and rebuild from the authoritative restored store before anonymous admission.

## Testing and reporting

Boot/auth/durability tests cover failures, concurrency, restart, real processes, ownership, lost writes and restore. Server tests focus on durable transactions, receipt migration/replay, snapshot visibility, schemas, authorization and cursors. UI acceptance is check/build and a few manual critical-flow and visual smokes; no blanket UI suite.

Run `bun run check` after code changes and relevant behavior tests. Close each combined wave with build and full retained tests. Repeat or broaden testing when changes, failures or unresolved concerns justify it. Report exact code, runtimes, worker count, totals and CI links; distinguish isolated evidence from integrated acceptance. Do not claim deployment, merge or full review resolution without evidence.
