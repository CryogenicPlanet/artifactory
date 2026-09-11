# Build plan

The lead owns delivery, integration and acceptance. Subagents take bounded assignments in isolated checkouts, with explicit file ownership. This is the implementation map for SPEC.md, not a replacement specification or a claim that all of it is complete.

## Current status

The local SQLite product includes passkey/account management, approved agent enrollment and refresh, conversations and unread state, search/reactions/topic metadata/archive/deletion, profiles, pages, a browser board and safe app/page undo. Runtime launchers seed editable TypeScript/UI source and prepare locked dependencies and board assets before rehearsal. Extensions support files/packages, routes, cron/event hooks and scoped KV/log/page helpers. Boot provides request diagnostics, age retention, hourly backups, weekly rehearsal drills and Linux kernel-identity recovery checks.

**The combined checkout passes 289 tests across 82 files, repository checks and all package builds.** The page-write admission regression also has a deterministic pending-publication test; it waits without blocking outbox progress and never retries an admitted publication. A fresh compiled smoke preserved all **49 acknowledged writes** across good/bad/good reloads, delivered each once over the same uninterrupted SSE connection, and preserved all 49 after a graceful boot restart. It also verified a new post/restart read, repaired extension response, served board JavaScript, prepared dependency/UI artifacts, passkey enrollment and staging isolation, with zero browser errors. Fresh review of the combined integration boundaries is clear. Real Linux/image acceptance is separate from these local results.

No public deployment or full-SPEC completion is claimed. Real Docker/Linux ownership and reboot acceptance remain unverified on this macOS host.

| Group | Integrated behavior | Remaining work |
| --- | --- | --- |
| A. Boot and source | Stable authenticated proxy/recovery; immutable snapshots; SQL lock/staging; recoverable publication; file edits/history/directory browsing; app/page undo; signed lock breaking; dependency/UI preparation before rehearsal | Direct-volume watcher, full generation/dependency restore, human revert through another holder’s lock |
| B. Durable kernel and events | SQLite writer fencing; atomic domain/outbox/retry outcomes; publication and restart reconciliation; real-route rolled-back health; boot event query/wait/SSE; age retention; editable transactional migrations; read-only SQL HTTP; bounded request diagnostics | SQL writes and their publication contract; remaining operational events/cross-process trace annotations; physical byte budgets; Postgres/MySQL compatibility |
| C. Conversation | Message CRUD/wait and filters; topics/unread/read marks; selectable inbox; search/reactions; metadata/archive/deletion; profiles/presence; bounded README/priorities/subtopic/inbox/activity context | Topic move; archive enforcement for page writes; no undelete/physical-erasure endpoint |
| D. Identity | Passkeys, signed enrollment, one-time collection, scopes, encrypted refresh replay, signed family revocation/lock break/token mint, account listings and browser controls | Signed settings, boot restart/reset, human database and source-plus-database restore |
| E. Cutover and recovery | WAL-inclusive rehearsal, prewarming, freeze/drain, synced pre-flip backup, durable acceptance/rollback, keeper receipts, Linux kernel boot-id checks, hourly backups and weekly scratch-store drills | Public backup listing/restore, snapshot/backup/artifact pruning, disk headroom/budgets, actual Linux reboot and ownership verification |
| F. UI and pages | Markdown board/composer, references, search/reactions, topic metadata/archive controls, profiles/accounts, extension status, pages and mobile layout; prepared snapshot-based assets; editable onboarding/public-page policy | Ordinary topic-history pagination, boot recovery controls, PWA and page revision polling |
| G. Extensions and packaging | File/package discovery, locked package preparation, overrides/parameters/wildcards, disabled diagnostics, live hooks/cron, scoped KV/log/page helpers, editable runtime seed and local image assembly | Durable webhook delivery/reference subscription extension, system-event mirror, remaining outbound helpers and Linux image isolation |

## Parallel work and dependencies

Keep independent delivery streams active rather than waiting for one long serial feature chain:

- **Restore:** backup listing, signed restore and generation/source-plus-database restore share the existing admission, journal and positive-closure boundary. Coordinate those interfaces centrally.
- **Topic move:** separately resolve its SQL/page/event visibility and recovery contract before implementing it.
- **Operations:** direct-volume watcher, physical retention/headroom and Linux ownership can proceed in isolated checkouts with explicit supervisor/storage ownership.
- **Extensions and UI:** system mirroring, durable subscriptions and remaining browser views stay separate from boot hardening.
- **Review and acceptance:** fresh agents inspect auth, publication, source containment, lifecycle and restart recovery while the lead runs combined checks and critical browser/reload smoke flows.

The lead is the only writer in the shared checkout and owns dependencies, schema merges and final acceptance. Read-only review can run alongside integration. No worker may reset, stash, clean or discard another worker’s changes. Commit or deploy only when requested.

## Delivery and testing rules

Use the three-package layout from docs/tech.md: boot, server and ui. `server/src/main.ts` launches boot; `server/src/server.ts` is the child. Pages belong in `packages/server/pages/`. No empty protocol package or speculative adapter/framework is needed.

Build the smallest complete slice. Prefer existing Effect services and direct SQL. Runtime state belongs to an explicit service instance, scope or component; avoid module-global mutable variables and containers. Optional product workflows belong in extensions. Simplicity must preserve authentication, boot recovery and data durability.

| Area | Acceptance effort |
| --- | --- |
| Boot/auth/recovery | Strong real-process and temporary-store tests: lost writes, stale writers, closure proof, restart/cutover phases, locks and staging, credential stripping, signed-proof replay and refresh races. Record acknowledged POST receipts across good/bad/good reloads and verify them after recovery. |
| Server transactions and API | Focused behavior tests for atomic outbox delivery, delayed publication, retry outcomes, authorization, read snapshots, cursor bounds, subtree matching and waits. |
| UI | A few browser smoke flows and visual checks: real sign-in, navigation, posting, uncertain retry and narrow layout. No coverage quota, blanket snapshots or styling tests. |
| Packaging | Build checks plus real Linux denied-read/write, WAL access, restart and restore tests before claiming production isolation. Local macOS runs cannot establish Linux ownership. |

Run `bun run check` after code changes and relevant tests for new behavior; all builds and a combined acceptance run close a wave. Vitest runs on Node and spawns actual Bun fixtures for Bun HTTP, SQLite and processes. Historical prototype latency is not current cutover evidence.

## Contracts to preserve

### Publication and SQLite ownership

Boot owns one outstanding app transaction reservation and `published_through`. App data, outbox, batch evidence and retry outcome commit together; publish the complete reserved batch before returning mutation success, including an idempotent replay. Higher boot events may be stored while a reservation is pending, but conversation reads and event cursors stay behind the fence. Conversation reads establish their SQL snapshot before capturing the fence and project prior images for pending edits, deletes, topics and reactions.

Every trusted kernel write first checks its attempt’s epoch while acquiring the SQLite write lock. Recovery installs a fresh epoch before inspecting authoritative committed evidence, then publishes a complete committed batch or aborts confirmed absence. Missing or inconsistent storage blocks app recovery while boot auth/help remain available. A timeout is not rollback evidence. This boundary protects trusted kernel paths; raw SQL and external extension side effects are not automatically safe.

### Safe edits and rollback

SQL staging is the only authoritative overlay. Source publication journals before/desired bytes, hashes and modes independently of staging; replay accepts the before or desired state and preserves a conflicting external edit. Publish through synced temporary files and parent directories. Multi-file publication is recoverable, not simultaneous. Files over 1 MiB remain writable but may omit retained history bytes; unavailable content never means deletion. First-edit undo retains eligible before-images.

Rehearse actual assembled create/read/context handlers inside a deliberately rolled-back transaction on a WAL-inclusive online clone. Candidate health must not publish probe activity. Freeze admission before body transfer, drain admitted writes through publication, reconcile, sync a backup and only then permit candidate database mutation. Record acceptance and the good generation before public writes. Pre-acceptance failure closes both owners before restore; post-acceptance recovery preserves newer writes. Clear a completed rollback journal before restarting prior-code live hooks, so another crash cannot restore the old backup over their acknowledged writes.

A keeper’s durable, attempt-bound receipt proves child exit. Missing closure proof stops replacement launch and reload; PIDs, failed connections and timeouts are not proof. Linux attempts also persist the validated kernel boot UUID. A different valid current UUID proves that earlier-kernel attempt has closed; same-kernel restarts, unavailable/malformed IDs, unsupported hosts and legacy rows still need receipts. Tests inject kernel identities, but real Linux reboot, process-tree and ownership behavior remain unverified; see [deployment.md](deployment.md).

Revert currently handles app file/batch/version selection through the ordinary lock and cutover. An Idempotency-Key binds the exact original history selection across restart, preventing a lost-response retry from undoing its own undo. It does not replay the exact HTTP outcome: repeated hooks/generations or replacement of later edits remain possible. Nonempty staging is refused; failed rehearsal keeps repair staging. Page-only selectors now publish directly through the durable page journal without an app lock or generation; another holder’s staging is preserved. Page replay preserves the selected history target but may create another history batch. Page writes and undo reject deleted topic subtrees at the boot publication gate. Generation/dependency restore, database restore and overriding someone else’s app lock are separate unfinished paths.

### Identity

Boot strips credentials and supplied identity headers, then forwards verified caller fields through the guarded attempt channel. Invalid explicit bearer credentials never fall back to a cookie. Session mutations check the exact Origin; sensitive human actions bind fresh passkey proof to canonical action parameters and recheck the live session inside the mutation transaction. Lock break binds the observed acquisition UUID, preserving replacement locks; pinned break/revocation defers release, never credential invalidation.

Enrollment collection returns random tokens once and stores hashes; a lost committed collection requires re-enrollment. Refresh has a fixed 60-second exact-successor replay window capped by predecessor expiry, backed by a short-lived authenticated encrypted receipt. After grace, only reuse of an unexpired predecessor whose exact successor was used revokes the family. Revocation and lock effects must commit before returning their semantic rejection. SPEC §4.4 retains the complete replay policy; do not replace it with generic rotation heuristics.

### Product and extension clarifications

- Inbox `mode=agent` includes the whole agent home tree; `mode=instance` includes the matching label’s branch and mentions. Both include `@here`, exclude the caller’s own instance and share one inbox mark. Clients needing independent mode cursors supply `since`.
- Topic PUT replaces metadata. Public pages require exact JSON `meta.public:true`; descendants do not inherit it. Anonymous reads can return retriable 503 throughout source preparation/rehearsal and cutover because the operation gate spans that work. Archived topics currently restrict conversation mutations, not boot page writes.
- Reaction toggle emits the SPEC-listed `reaction.added` event with `active:false` for removal. Consumers must inspect active state rather than infer it from the event name.
- Search uses literal Unicode words/quoted phrases combined with AND, ordered by creation sequence. It is not relevance ranking or a change feed; restart from zero to discover newly matching edits to old messages.
- Context budgets approximate four UTF-16 code units per token and report truncation. The latest-200-message source window may omit older pinned content; sections are separately read and never advance read marks.
- An optional extension import/factory failure disables that extension; registered routes return 503. Required app/kernel import failures and broken health-probed overrides reject the candidate. Runtime extension imports are explicitly allowed.
- Start/shutdown run per live period. Freeze closes live scopes; canceled freeze creates fresh scopes. Completed cleanup defects disable one extension and let siblings close. Hanging cleanup requires keeper-confirmed process closure, never a timeout treated as success.
- Cron uses five-field UTC schedules, runs each registration serially and skips missed ticks. Event hooks begin at their generation’s load fence, consume only published events and retain a cursor across canceled freeze. They are best-effort across replacement/crash; external effects can replay. Returned Promises are awaited because they cannot be canceled. In-memory diagnostics, including a cron completion during successful freeze, may disappear if the process exits before publication. Durable subscriptions are separate work.
- Topic deletion is a published root tombstone. Sole ownership means the same instance authored every retained subtree message, including deleted messages; empty/page-only subtrees require a human. Deleted paths remain reserved and ordinary readers/writers hide/refuse them. Files and historical events remain retained for fs-authorized inspection. Topic move still needs recoverable coordination across SQL, page files and boot events.
- Read-only `/api/sql` exposes bounded physical committed rows, including unpublished state, without a publication cursor. It is a diagnostic surface, not a substitute for publication-safe conversation reads. SQL writes remain unsupported.
- Runtime preparation uses a standalone manifest/lock and fixed install/build commands before rehearsal/freeze, with package lifecycle scripts disabled. Retained artifacts are separate from disposable workspaces; snapshots restart without install/build. Existing source is never reseeded. Preparation/app processes still share the current OS user; editable build code is not an enforced sandbox.
- Hourly backups freeze/drain and reconcile before recording a synced clone with generation/fence provenance; weekly drills use the newest cataloged backup and current healthy source in private rehearsal. Neither restores live data. Attempt times persist before work to avoid immediate replay after restart. Uncataloged crash leftovers and uncertain drill scratch are retained; pruning and physical headroom remain unfinished.
- Request diagnostics record completed child dispatches without queries, headers or bodies. A bounded boot-owned queue decouples logging from traffic admission, so saturation, storage failure or shutdown can drop records. They are not audit receipts or mutation-success conditions; boot-owned routes are excluded to avoid feed self-logging.
