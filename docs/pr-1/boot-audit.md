# Bootloader minimality audit

`packages/boot/src`, branch `codex/build-comms-core`, measured 2026-09-10.

**The count in the review is stale.** `adversarial-findings.md:219` and `pr-comments.md` item 8 say 7,239 lines in 61 files. `find packages/boot/src -name '*.ts' | xargs wc -l` now reports **9,585 lines in 81 files** with 5 runtime dependencies. The families added since that count are topic move (516), database restore (522), storage measurement (254) and the backup drill (89). Every number below is from `wc -l` on the files named.

## 1. The test applied to each file

The owner's rule, sharpened: **the bootloader should only have critical things; think an actual bootloader.** A real bootloader brings up the hardware, verifies and loads the next stage, falls back to a known-good image when the new one fails, and gives you a way in when everything else is broken. Translated to this system that is six jobs and no others: listen and proxy with credential stripping; passkey authentication, enrollment and refresh; seq allocation with event append and read; snapshot, rehearse, swap and roll back generations with the keeper receipt and freeze/drain/backup; the edit lock, staging and the publication journal.

So each file got two questions. **Is it one of those six jobs, or a mechanism one of them strictly needs?** If not, it goes, regardless of whether the app can currently reach the thing it touches — "the app cannot read `boot.db`" is a reason to expose a narrow primitive, never a reason to put a feature in the image. **And if it were wrong, could an agent fix it by editing over HTTP, and would a broken version stop an agent from editing, authenticating, or keeping its data?** A file that an agent cannot repair and whose failure breaks none of the three is the worst possible trade: an un-repairable line bought for nothing.

The distinction that decides most of the borderline cases is **mechanism versus policy**, and within policy, whether boot has to be able to enforce it when the app is dead:

| Concern | Mechanism — stays in boot | Policy — goes to the app | Why the line falls there |
| --- | --- | --- | --- |
| Backups | Take a consistent copy on demand under freeze and drain; restore one through the close-handle protocol; take the pre-flip copy inside the cutover | When to take one, how many to keep, the 20% cap | A dead app writes nothing, so a schedule missed while the app is down loses nothing. The pre-flip copy is part of the swap mechanism and stays. |
| Event retention | The prune itself, plus a ceiling boot enforces for its own survival | The 7-day and 30-day numbers, already read from `settings` at `event-retention.ts:13-18` | **Policy boot must enforce when the app is dead.** Only boot can write `boot.db`, and a full `boot.db` breaks authentication. |
| Disk | A free-space probe and the 5% write refusal §7.5 promises | The per-category usage dashboard | The refusal is the only part that protects the volume, and it does not exist today. The dashboard is policy boot merely happens to compute. |
| Public pages | The yes/no "is this path public" check, before any proxying | What makes a topic public, `index.md` resolution, child-topic listing | The unauthenticated floor is genuinely an auth decision. `meta.public` is a topic semantic. |
| Agents, presence, unread | Nothing | Everything | Derivable from the identity headers boot already forwards at `proxy.ts:299-307`. |
| Credentials | Mint, rotate, revoke, verify, and list enough to name a family for revocation | Display, grouping, anything cosmetic | Credential management must work when the app is dead; that is the "way in when everything is broken". |
| Source | The publication journal, staging, the lock, path safety | What a valid edit means beyond path safety | |
| Generations | Snapshot, rehearse, swap, roll back | Which commands prepare one, and their caching | |

## 2. File-by-file

Verdicts are against the **recommended** cut (§3B). Where the intermediate step (§3A) keeps something the recommended cut removes, the row says so.

### Listener, proxy, wiring — job 1

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `index.ts` | 147 | Builds the layer graph, recovers in intent order, serves the one catch-all route | KEEP (−25 by merge) | Owns the public listener. Three nested `Effect.gen` tiers and four null-holding `Ref`s (`index.ts:41-49`) collapse into one graph. |
| `proxy.ts` | 368 | Route dispatch, credential stripping, identity headers, freeze admission, 503 body | KEEP | `proxy.ts:276-285` is the credential-stripping floor of §4.3 and can exist nowhere else. |
| `traffic.ts` | 72 | Two admission gates: mutation freeze/drain and the request gate | KEEP | §7.7 step 4. No acknowledged write survives a cutover without it. |
| `recovery-intents.ts` | 30 | One SQL snapshot of the four durable recovery admissions | KEEP | `index.ts:72` refuses to start when two intents conflict. |
| `boot-schema.ts` | 86 | The 13-rung boot store ladder; refuses a newer store | KEEP (+35 by merge) | Absorbs the six rung-only `*-schema.ts` files below. |
| `kernel-boot.ts` | 25 | Reads and validates `/proc/sys/kernel/random/boot_id` | **KEEP** | The review calls this speculative (`adversarial-findings.md:254`). It is the opposite: `child-attempts.ts:49-52` is the only path that closes an attempt after a power loss destroyed the keeper receipt. Delete it and a host reboot mid-cutover is permanently unrecoverable in-band. |

### Authentication, enrollment, tokens — job 2

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `auth.ts` | 376 | Passkeys, sessions, setup code, the seven action-bound assertions | KEEP | §4.2. No edit can lock the human out only because this is in the image. |
| `auth-http.ts` | 261 | Setup/login/logout routes, body reader, bearer and cookie parsing, error mapping | KEEP (−60 by merge) | `auth-http.ts:30-91` is a 62-line nested ternary that becomes a `Record<code,{status,hint}>`; `pr-comments.md` item 6, already confirmed. |
| `auth-page.ts` | 64 | The static setup/login HTML and its client JS | KEEP | Must render when no app process exists. |
| `auth-schema.ts` | 18 | `passkeys`, `auth_challenges`, `sessions` DDL | MERGE into `boot-schema.ts` | A rung, not a concept. |
| `enrollment.ts` | 229 | Create, decide, collect, and authenticate access tokens | KEEP | §4.1. Mints credentials. |
| `enrollment-schema.ts` | 39 | `Scope`, decision canonicalisation, `enrollments`/`tokens` DDL | KEEP; DDL merges | The canonical form is a cryptographic binding. |
| `enrollment-http.ts` | 133 | Enroll, poll with `?wait=`, approve, `/_boot/auth/challenge`, approve page, QR | KEEP (−20) | Delete the two `QRCode.toString` branches at `:59` and `:72`; see §5. |
| `enrollment-page.ts` | 57 | The approve page and its client JS | KEEP | SPEC §6 says approval is served by boot so it works when the app is down. |
| `tokens.ts` | 270 | Refresh rotation, the 60s grace window, family revocation, theft detection | KEEP | §4.4. A wrong version either locks every agent out or never expires a stolen token. |
| `token-http.ts` | 39 | `POST /auth/refresh`, `POST /_boot/tokens/:family/revoke` | KEEP (−9 by merge) | Refresh must answer when the app is dead. |
| `refresh-schema.ts` | 52 | `TokenPair`, `Receipt`, receipt DDL, lazy expiry | KEEP; DDL merges | |
| `refresh-receipt.ts` | 78 | AES-GCM sealed receipt so a lost refresh response is recoverable | KEEP | Without it a dropped response strands a live agent. |
| `token-mint.ts` | 181 | Human-minted pair for headless jobs, session-encrypted receipt | KEEP | SPEC §6 route table, human-only, mints credentials. Flagged in §3C as the one auth feature that could go. |
| `token-mint-schema.ts` | 52 | Mint binding, validation, `mint_receipts` DDL | KEEP; DDL merges | |
| `token-mint-http.ts` | 38 | `POST /_boot/tokens` | KEEP (−9 by merge) | |
| `passkey-management.ts` | 159 | List, register and delete additional passkeys | KEEP | §4.2: a second device is the only defence against the shell-in-and-`delete from passkeys` recovery. |
| `passkey-management-schema.ts` | 56 | Registration response schema, label/id validation, canonical bindings | KEEP | Cryptographic bindings. |
| `passkey-management-http.ts` | 52 | The four `/_boot/auth/passkeys` routes | KEEP (−9 by merge) | Credential management; must work when the app is dead. |
| `lock-break.ts` | 57 | Human lock break: fresh proof, live session, lock transition, audit event, one transaction | KEEP | §7.6. The only way past a wedged holder. |
| `lock-break-schema.ts` | 7 | `BreakLock` struct, lock-id validation, canonical form | MERGE into `lock-break.ts` | Exists to break the `edit-http.ts` → `auth.ts` cycle. The review says it "contains no schema" (`adversarial-findings.md:219`); it does, at `:3`. The file is still pointless. |
| `account-queries.ts` | 68 | Paginated enrollment and token-family listings with lexical cursors | MERGE to ~35 total | **Credential management, so it stays** — but as one unpaginated read, not a catalogue. §4.4 revocation needs a family id and the app cannot read `boot.db`. The cursor schemas, the five-parameter allowlist at `account-http.ts:20-34` and the status-projection CASE at `account-queries.ts:43` go. |
| `account-http.ts` | 43 | `GET /_boot/enrollments`, `GET /_boot/tokens` | MERGE (see above) | Neither route is in the SPEC §6 table; the surviving one should be added. |
| `agent-roster.ts` | 28 | Three-way UNION over enrollments, tokens and sessions for `/_boot/agents` | **DELETE** | Not credential management — it is a presence listing, and the app can build it without asking boot anything. Boot forwards `X-Chirp-Agent`, `X-Chirp-Instance` and `X-Chirp-Label` on every request (`proxy.ts:299-307`), and SPEC §6 already says "every authenticated request updates the instance's `last_seen_at`; there is no separate presence ping". So the app maintains its own `agents` row and `GET /api/agents` becomes a small extension over that table rather than a kernel route backed by a boot channel call. The route is also absent from the SPEC §6 table and is a third localhost-channel capability where §7.9 enumerates two. One detail the UNION hides: `agent-roster.ts:24` splices human sessions in as a pseudo-agent literally named `rahul` — one of **eight hardcoded `"rahul"` literals across seven files** (`auth-http.ts:155`, `enrollment.ts:89` and `:131`, `tokens.ts:102`, `token-mint.ts:167`, `token-mint-schema.ts:16`, `lock-break.ts:36`, `database-restore.ts:142`). Deleting the roster removes one and leaves the human's identity where it belongs, synthesized once at `auth-http.ts:155`. Also deletes the branch at `event-http.ts:147-151` and the dispatch at `proxy.ts:115`. |

### Edit lock and edit routes — job 6

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `edit-lock.ts` | 351 | Acquire/renew/release/pin/finish, staging overlay, commit-time authority, recovery | KEEP (−12) | §7.6. The authority check at `:146-153` is duplicated verbatim at `source-files.ts:374-385`. |
| `edit-http.ts` | 279 | `/_boot/lock`, `/_boot/reload`, `/_boot/revert`, `/_boot/fs/*`, `/_boot/fs/edit` | KEEP (−40 by merge) | §7.1 invariant 2 is this file. Ternaries at `:231-257` become a record. |

### Source publication journal — job 6

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `source-files.ts` | 445 | The single admission gate over read/browse/stage/edit/prepare/publish/materialize | KEEP ~410 | §7.5's recoverable multi-file publication. The `withPageMove`/`pageMoveReady` plumbing (~15) goes with the page move; the `prepareWatcher`/`observe`/`adoptWatcherBaseline` plumbing (~35) goes with the watcher. |
| `source-journal.ts` | 312 | Publication batches, version history, undo selection with idempotency, tree undo | KEEP | `POST /_boot/revert` always works because of this file. |
| `source-io.ts` | 141 | Path resolution rejecting symlinks and aliases; atomic replace with fsync | KEEP | |
| `source-schema.ts` | 88 | `SourceRejected` codes, `Image`/`Change`/`Batch`/`Version`, source DDL | KEEP; DDL merges | |
| `source-tree-publication.ts` | 179 | Whole-tree publication including empty directories, with conflict detection | KEEP | Generation revert restores a whole tree; this is how. |
| `generation-source.ts` | 43 | Validates a generation snapshot is a verified editable tree before reverting to it | KEEP | Refuses to revert to a snapshot preparation overwrote. |
| `source-tree.ts` | 44 | Inventory of the editable tree for the watcher baseline | **DELETE** | Only the watcher uses it. |
| `source-observation.ts` | 151 | Captures external edits and the authoritative watcher baseline | **DELETE** | Serves the watcher only. |
| `source-watcher.ts` | 65 | Debounced volume watch plus periodic reconciliation, cutover under a boot-held lock | **DELETE** | SPEC §7.1 calls it "a fallback for edits made outside the API". An actual bootloader does not watch a directory for someone else's edits; the way in is the API, and the API works. A broken watcher stops nobody from editing. Cost and spec edit in §3B. |

### Cutover, supervision, generations — jobs 4 and 5

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `cutover.ts` | 324 | Rehearse, publish, pre-warm, freeze, back up, go, accept, roll back | KEEP | §7.7 verbatim. This is "load the next stage and fall back". |
| `cutover-schema.ts` | 9 | `child_attempts`, `backups`, `cutover` DDL | MERGE into `boot-schema.ts` | |
| `supervisor.ts` | 263 | Launch, admit, retire, activate, start, crash recovery with backoff and good-generation fallback | KEEP | §7.1 invariants 3 and 4. |
| `child-process.ts` | 127 | Spawns the keeper, reads port and pid, control channel, health poll, closure proof | KEEP (−14) | The IPC `Configuration` schema at `:20-26` is declared four times across the process boundary. |
| `child-keeper.ts` | 65 | Owns one app process; pipe EOF kills it and fsyncs an attempt-bound receipt | KEEP | The single most load-bearing file for durability. Boot death cannot leave a second database writer alive. |
| `child-attempts.ts` | 66 | Durable attempt rows and the fail-closed receipt verification loop | KEEP | `:54-58` is why a restore never races a live writer. |
| `generations.ts` | 62 | Generation history, the `good` tag, reserve/healthy/failed | KEEP | "Fall back to a known-good image" is this table. |
| `snapshots.ts` | 140 | Copies committed source into `gen/<n>/source`, writes the editable fingerprint marker | KEEP | Children run from immutable snapshots. |
| `application.ts` | 125 | First-boot seeding of `app/` and `pages/`, snapshot entry validation | KEEP | `:61-67` refuses to replace edited source with seed. |

### Generation preparation — job 4, and the furthest thing from a bootloader

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `generation-preparation.ts` | 286 | `treeHash`, a content-addressed artifact store under `prepared/`, per-`ext/` installs, UI build promotion | KEEP ~95, **MOVE ~191** | Boot needs "run these two fixed commands in the snapshot and reject on failure". `:34-50` is a tree hasher, `:104-177` and `:256-277` a content-addressed cache with partial-promotion renames, `:199-229` a per-extension package manager. A stale cache key produces a stale build, which an agent fixes by editing and reloading, so it fails the test outright. See §3C for the stronger version of this call. |
| `preparation-process.ts` | 73 | Spawns the preparation keeper with the 60s/120s deadlines | KEEP | §7.1's "slow work happens before the freeze". |
| `preparation-keeper.ts` | 89 | Runs exactly `bun install --frozen-lockfile --ignore-scripts` or `vite build`, kills the process group | KEEP | An editable `vite.config` must not outlive its deadline. |
| `prepared-tree.ts` | 53 | `copyPreparedTree` (link-safe copy) and `syncPreparedTree` | KEEP ~17, MOVE ~36 | `copyPreparedTree` exists only for artifact promotion and goes with the cache. |

### Events, sequence, fence — job 3

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `events.ts` | 255 | Seq allocator, reservation, batch append with replay validation, `topic.moved` prefix rewrite, query | KEEP (−18, +12) | §6.3's one allocator and fence. Delete the JS re-filter at `:230-249`, which re-applies in JavaScript the predicate the SQL at `:215-223` already applied. The `topic.moved` block at `:107-131` stays: rewriting `events.topic` in `boot.db` is the one part of a topic move only boot can do. Add ~12 lines to project `topic.meta` payloads into the public-path allowlist in the same transaction (see `public-pages.ts`). |
| `event-http.ts` | 183 | The child channel (`/_boot/seq*`, `append`) and the authenticated event query | KEEP (−25) | The channel exists because boot mints `seq`. Drop the `/_boot/agents` branch and collapse the ternary at `:117-132`. |
| `public-event-http.ts` | 107 | Query validation, long-poll with heartbeats, SSE with `Last-Event-ID` | KEEP ~77, **MOVE ~30** | The long-poll is part of the edit loop: the `423 locked` hint in §7.6 tells the blocked agent to wait on `lock.released`. SSE is a delivery preference and the app can serve it. |
| `event-routing-schema.ts` | 9 | Adds the indexed `events.topic` column | MERGE into `boot-schema.ts` | |
| `event-retention.ts` | 57 | Hourly chunked prune of published events against a settings policy | KEEP | Policy boot must enforce when the app is dead: only boot writes `boot.db`, and a full `boot.db` breaks authentication. The numbers already come from `settings`, which is the right shape. |
| `request-events.ts` | 65 | Bounded queue writing one `http.request` event per proxied request | **DELETE** | Not one of the six jobs. Boot keeps `events.writeBoot` for its own lifecycle events (`lock.*`, `generation.*`, `backup.taken`, `token.*`, `enrollment.*`); per-request observability is the app's, which sees every request it serves. Spec edit to §6.1, and a real cost in §3B. |

### Backups and restore — job 4

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `app-backup.ts` | 66 | `VACUUM INTO` clone, clone preparation with a fresh epoch, file restore | KEEP ~46 | Pure mechanism, and it must run with no app alive. **But `:43` reads `MAX(seq) FROM messages`** — a domain table — to compute a rehearsal ceiling boot already knows as `seq.next` in its own store. Pass the ceiling in and delete `:36-46` entirely, including the legacy `user_version === 0` branch. −20. |
| `app-recovery.ts` | 139 | Installs a fresh writer epoch, reads committed batch/outbox evidence, resolves the reservation | KEEP | §6.3's fence. It touches only `kernel_writer`, `mutation_batches` and `outbox` — exactly the three tables §6.3 says boot initializes — and its own comment at `:18` states the rule the rest of boot should follow: "Domain schema remains owned by editable server code." |
| `backup-inventory.ts` | 36 | Paginated backup catalogue read | KEEP | `POST /_boot/db/restore` needs an id and the human gets it here when the app is dead. |
| `backup-http.ts` | 56 | `GET /_boot/db/backups` | KEEP (−15 by merge) | |
| `backup-metadata.ts` | 19 | `BackupRecord` plus `published_through`/`generation` columns | KEEP; DDL merges | `published_through` is what makes a backup restorable (`database-restore-auth.ts:78`). |
| `scheduled-backup.ts` | 115 | Hourly backup under a real freeze and drain, with restart-on-failure | KEEP ~25, **MOVE ~90** | The copy mechanism is boot's; **the schedule is not**. Boot exposes `POST /_boot/db/backup` (human or `fs`) that does freeze, drain, clone, catalogue; the app's cron calls it hourly. A dead app writes nothing, so a schedule missed while the app is down loses nothing, and the pre-flip copy inside `cutover.ts` covers the bad-edit case regardless. |
| `backup-drill.ts` | 89 | Weekly restore rehearsal into a scratch store | **DELETE** | A schedule plus a rehearsal. SPEC:649 puts it in phase 4, no test references it, and a failed drill changes nothing an agent can act on. |
| `storage-maintenance.ts` | 44 | One loop with persisted attempt times for the hourly backup and the weekly drill | **DELETE** | Both schedules leave; nothing remains. |
| `database-restore.ts` | 306 | Phase journal: authorize, safety backup, restore, candidate, accept or roll back | KEEP | "Fall back to a known-good image" for data, human-only, must run with no app alive. Flagged in §3C as the one mechanism whose HTTP surface could become a shell procedure. |
| `database-restore-auth.ts` | 107 | Durable authorization receipt bound to proof, session and idempotency key | KEEP (−11) | `canonicalProof` at `:7-17` is verbatim `token-mint.ts:26-36`. |
| `database-restore-http.ts` | 47 | `POST /_boot/db/restore` | KEEP (−9 by merge) | |
| `database-restore-schema.ts` | 45 | Params, validation, canonical binding, the request row | KEEP | |
| `database-restore-journal.ts` | 17 | `db_restore_requests` DDL and its two unique indexes | MERGE into `boot-schema.ts` | |

### Storage measurement — policy boot merely computes

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `storage-usage.ts` | 166 | Walks eleven categories of the volume counting allocated blocks, de-duplicating inodes | **DELETE** | Read at exactly one place, `proxy.ts:217`, to fill a field in the `/_boot/status` body. §7.5 asks boot for two things — that `/_boot/status` show usage against each budget, and that boot "refuses any write that would leave less than 5% headroom" — and **neither budget nor refusal exists anywhere in the tree**: `grep -in 'headroom\|prune\|budget' packages/boot/src/*.ts` matches only `event-retention.ts`. Boot pays 254 lines for a dashboard and skips the 15 that protect the volume. |
| `storage-volume.ts` | 88 | Parses `stat -f` or `df -kP` for capacity and free space | KEEP ~55 | Keep the free-space probe as the mechanism behind the 5% refusal, and spend the saved lines implementing it and the §7.5 caps. |

### Public pages — the auth decision stays, the topic semantics go

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `public-pages.ts` | 188 | Resolves `/p/**`, opens a second SQLite connection to the app store, reads `topics.meta.public`, resolves `index.md`/`index.html`, enumerates public child topics, gates page writes on topic tombstones | KEEP ~35, **MOVE ~153** | The yes/no "is this path public" check is genuinely an auth decision and stays in boot, ahead of any proxying (§4.3: "the unauthenticated floor is therefore in the bootloader"). Everything else in this file is the app's model of what a topic is. The concrete split is in §2.1. |

#### 2.1 The public-pages split, concretely

**What leaves boot.** The two read-only connections to `comms.db` at `public-pages.ts:44` and `:139`; the `SELECT path,meta,deleted_at FROM topics` at `:134`; the `meta.public !== true` rule at `:152`; the `deleted_at` ancestor check at `:149`; the `index.md`/`index.html` resolution at `:156-160`; the public child-topic enumeration at `:162-169`; and the whole `withWrite` page-write gate at `:53-102`, which checks `topics.deleted_at` and `topics.archived_at` before a page write — all 50 lines of it, including the 1-second retry loop at `:57-100`. The app refuses a write to a deleted or archived topic's pages itself, before it ever calls `PUT /_boot/fs/pages/...`; it owns those columns and is the only thing that can keep the rule correct when an agent reshapes them.

**What stays in boot, ~35 lines.** `pagePath` validation (`:14-28`, 16 lines, path safety is boot's); the realpath walk that refuses symlinks and escapes (`:116-124`, ~10); one read against a `public_paths` table in `boot.db` — `SELECT 1 FROM public_paths WHERE path = ? OR ? LIKE path || '/%' LIMIT 1`, ~6 lines; and the service wrapper and layer, ~5. No app-store connection, no `events.state` fence at `:131` (there is nothing to fence once there is no app-store read), no `operationGate`/`channelGate` wrapping, no `Marker` schema — the children array it carries is the app's index listing, so the marker collapses to the resolved path in one header.

**How `public_paths` is maintained.** Not through a new channel verb. `topic.meta` is already an event type the app appends through `POST /_boot/events/append` (§6.1), and `events.ts:107-131` already special-cases one event type (`topic.moved`) to maintain boot-side state in the same transaction. Add ~12 lines beside it that project a `topic.meta` payload's `public` flag into `public_paths`, plus a 3-line DDL rung. This is strictly better than the current design on two counts: the grant becomes visible exactly when the app's transaction publishes, which is the fence `public-pages.ts:131` is currently straining to emulate with a retry loop; and boot's knowledge shrinks from "the shape of the `topics` table" to "one boolean in one event payload". Net for the whole change: −153 in `public-pages.ts`, +15 elsewhere, **−138**.

### Topic move — a product route in the immutable core

| File | Lines | What it does | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `topic-move.ts` | 179 | Freezes requests, drains, prepares the page tree, calls the child's `/_kernel/topic-move`, verifies committed evidence, unfreezes | **MOVE to `ext/core.ts`** | SPEC §6 assigns `POST /api/topics/<path>/move` to the extension routes in `app/ext/core.ts` and gives boot exactly one job: "the bootloader rewrites `events.topic` for the subtree on receipt." That job is the 25 lines already in `events.ts:107-131`. This coordinator, plus the interception at `proxy.ts:177-180`, is a product feature an agent cannot repair. |
| `topic-move-http.ts` | 70 | Intercepts `POST /api/topics/*/move`, maps nine codes to status | **MOVE** | Goes with the coordinator. |
| `topic-move-schema.ts` | 27 | `topic_moves` row, DDL, path validation | KEEP ~8 | Only the append-time evidence check survives. |
| `topic-move-recovery.ts` | 42 | `beforeAppend`/`afterResolve` hooks that publish pages and mark the move on receipt | KEEP ~10 | Collapses to the evidence check in `append` once there is no page rename to coordinate. |
| `topic-page-move.ts` | 186 | Captures a page subtree fingerprint, renames it atomically, aborts or finishes under the source gate | **MOVE** | The pages tree is inside boot's publication journal, so an atomic subtree rename has to be boot's — which is exactly why the feature should not need one. The app moves pages file by file through the ordinary journal. Real cost in §3B. |
| `topic-page-move-schema.ts` | 12 | `topic_page_moves` DDL and its single-pending index | **MOVE** | |

## 3. Sums

### 3A. Intermediate step: no guarantee weakened, no spec edit required

Do this first; it is all refactoring and deletion of work the spec already defers.

| | Lines |
| --- | --- |
| Starting point | 9,585 |
| DELETE: `backup-drill.ts` 89, drill branch 10, `agent-roster.ts` + route 37, `storage-usage.ts` 166, `app-backup.ts` ceiling query 20, `events.ts` JS re-filter 18 | −340 |
| REDUCE: `generation-preparation.ts` −191, `prepared-tree.ts` −36, account listings −76, `storage-volume.ts` −33 | −336 |
| MERGE (detail below) | −462 |
| **Intermediate size** | **≈ 8,450 in ≈ 74 files, 5 deps** |

### 3B. Recommended: the six jobs and nothing else

| | Lines |
| --- | --- |
| Intermediate size | 8,450 |
| DELETE the watcher: `source-watcher.ts` 65, `source-observation.ts` 151, `source-tree.ts` 44, `source-files.ts` plumbing ~35 | −295 |
| DELETE `request-events.ts` 65 and its wiring at `proxy.ts:322-329` ~8 | −73 |
| MOVE topic move: `topic-move.ts` 179, `topic-move-http.ts` 70 | −249 |
| MOVE the atomic page-subtree rename: `topic-page-move.ts` 186, its schema 12, `topic-move-recovery.ts` −32, `topic-move-schema.ts` −19, `source-files.ts` plumbing ~15 | −264 |
| MOVE the backup schedule: `scheduled-backup.ts` 115 → ~25, `storage-maintenance.ts` 44 | −134 |
| MOVE the public-page topic semantics (§2.1), net | −138 |
| MOVE SSE to the app: `public-event-http.ts:72-89` | −30 |
| DROP `qrcode`: the two branches at `enrollment-http.ts:59,72` | −20 |
| **Recommended size** | **≈ 7,250 in ≈ 67 files, 4 deps** |

Cross-check by composition rather than subtraction, adding up only the six jobs: listener and proxy 587, auth and credentials 2,153, seq and events 611, generations, backups and restore 2,396, the edit loop and journal 1,760, shared schema and the page check 176, minus 462 of merge — **≈ 7,220**. The two methods agree within 30 lines.

**Where the 7,250 actually is.** Two of the six jobs are each bigger than everything else put together: authentication and credentials, ≈2,150 (30%), and the generation lifecycle with backups and restore, ≈2,400 (33%). The edit loop and publication journal are ≈1,760 (24%). Inside that, ≈2,325 lines are nothing but "no acknowledged write is ever lost": the keeper receipt protocol (`child-keeper.ts`, `child-attempts.ts`, 131), the writer-epoch fence and committed-evidence reader (`app-recovery.ts`, 139), the recoverable multi-file publication journal (1,077), the durable cutover record with phase-correct rollback (`cutover.ts`, 324), the restore phase journal (`database-restore.ts`, 306), and refresh rotation with grace and replay receipt (348). **The spec's "a few hundred lines, two deps" is wrong by an order of magnitude, and SPEC §7.1 is what should change** — to about 7,000 lines and four dependencies — because every one of those lines is inside a job the owner named.

**What the recommended cut honestly weakens.** Five things, in descending order of how much they would annoy me.

1. **A topic move stops being atomic.** SPEC §6 says a move rewrites topics, messages, reads and the pages directory "in one transaction". Without `topic-page-move.ts` the app moves pages file by file through the ordinary journal, so a crash mid-move leaves pages split between the old and new topic. It is re-runnable and every file write is still journaled, so nothing is lost — but the operation is no longer all-or-nothing. Spec edit to the §6 row.
2. **Shell edits to `/data/app` never deploy.** §7.1 and §7.5 both promise they do, versioned as `watcher`. Losing the baseline also means boot can no longer tell an external edit from a journaled one, so a direct write becomes invisible rather than merely undeployed. Spec edit to both.
3. **No `http.request` events for what boot answered.** The app still logs everything it serves, but the 401s, 503s and enrollment polls boot handles while the child is down stop being recorded — which is exactly the window you want forensics for when an agent says it cannot authenticate. Spec edit to §6.1. This is the one I would reconsider if the owner disagrees; 65 lines is cheap for that record.
4. **A missed hourly backup is now possible.** If an agent breaks the app's cron and then runs a destructive `POST /api/sql` with no intervening reload, the recovery point is the last pre-flip backup instead of the last hour. Bounded, self-inflicted, and the agent can fix the cron by editing — but it is a real narrowing.
5. **An app swap drops `/api/stream`.** §6.2 promises it does not. The long-poll form survives in boot and `/init` already recommends it for anything over a few seconds.

Two things it makes *better*, worth saying because they are not just relocations: the public-page grant becomes visible exactly when the app's transaction publishes, replacing the 1-second retry loop at `public-pages.ts:57-100`; and boot stops knowing any domain table name at all (see §4).

### 3C. Further, only if the owner accepts a redeploy for some things

Each of these is a real capability loss, listed so the choice is explicit. I do not recommend any of them yet.

| Change | Saving | What it costs |
| --- | --- | --- |
| Bake dependencies and the UI build into the image; boot refuses a batch touching `package.json` or `ui/` with a hint to redeploy. Deletes `generation-preparation.ts`, `preparation-process.ts`, `preparation-keeper.ts`, `prepared-tree.ts` | −274 beyond 3B | An actual bootloader does not run a package manager, and this is the single most un-bootloader-like thing left in the tree. But it directly contradicts §7.1's "if the batch touches `package.json`, `bun install` runs" and §11, and an agent could no longer add a dependency or change the UI without a redeploy — which is the loop the whole project exists to remove. |
| Drop headless token minting: `token-mint.ts`, its schema and route | −271 | A headless job enrolls like anything else, costing one passkey tap. Removes a whole second receipt-encryption path and an assertion action. Spec edit to the §6 `POST /_boot/tokens` row. |
| Make database rollback a documented shell procedure: delete `database-restore*.ts` | −522 | Restoring data would need infrastructure access, breaking §7.5's "human, over HTTP" and leaving a bad migration recoverable only by someone who can reach the box. I would not do this. |

If all three were taken, boot would be ≈6,180 lines — and would no longer do two things the spec promises.

### The 462 MERGE lines

Each independently derived, each covered by an existing test.

| Collapse | Sites | Saving |
| --- | --- | --- |
| One `bootRoute` preamble for the 11 route modules | `auth-http.ts:178`, `passkey-management-http.ts:7`, `account-http.ts:8`, `token-mint-http.ts:15`, `token-http.ts:7`, `enrollment-http.ts:35`, `backup-http.ts:10`, `database-restore-http.ts:12`, `topic-move-http.ts:22`, `edit-http.ts:37`, `event-http.ts:50` | 70 |
| `Record<code,{status,hint}>` for four nested-ternary tables | `auth-http.ts:30-91`, `edit-http.ts:231-257`, `event-http.ts:117-132`, `topic-move-http.ts:45-68` | 100 |
| One `auth-primitives.ts`: `hash` ×4, `random` ×4, `denied`/`refuse` ×4, the `committed` idiom ×5, the redaction regex ×7 | `auth.ts:55,74,75`, `tokens.ts:26,38,42,86`, `token-mint.ts:25,47,48`, `enrollment.ts:46,47,60,149`, `passkey-management.ts:131,153`, `lock-break.ts:47`, `database-restore-auth.ts:101`, `index.ts:82,92`, `supervisor.ts:77`, `cutover.ts:255,265`, `preparation-process.ts:62`, `topic-move.ts:156` | 85 |
| One `rows(sql, Schema)` decode helper | 61 `decodeUnknownEffect(Schema.Array(...))` sites | 60 |
| Inline the six rung-only `*-schema.ts` files | `auth-schema.ts`, `cutover-schema.ts`, `event-routing-schema.ts`, `database-restore-journal.ts`, `topic-page-move-schema.ts`, `lock-break-schema.ts` | 35 |
| One `Token` row schema | `tokens.ts:11-25`, `token-mint.ts:12-24`, `enrollment.ts:37-45` | 30 |
| One layer graph in `index.ts` | `index.ts:41-49`, `:54-131` | 25 |
| One `sync(directory)` helper | `source-io.ts:39`, `source-tree-publication.ts:28`, `app-backup.ts:10`, `prepared-tree.ts:48`, `generation-preparation.ts:70`, `topic-page-move.ts:89` | 20 |
| One IPC `Configuration` schema | `child-process.ts:20-26`, `child-keeper.ts:5-11`, `preparation-process.ts:5-9`, `preparation-keeper.ts:7-11` | 14 |
| One commit-time authority check | `edit-lock.ts:146-153`, `source-files.ts:374-385` | 12 |
| One `canonicalProof` | `token-mint.ts:26-36`, `database-restore-auth.ts:7-17` | 11 |

## 4. The two boundaries, and an invariant worth enforcing

### Boot reaching into the app

`grep -n 'SqliteClient.layer' packages/boot/src/*.ts` finds five sites where boot opens a SQLite store other than `boot.db`:

| Site | Tables touched | Verdict |
| --- | --- | --- |
| `app-recovery.ts:104` | `kernel_writer`, `mutation_batches`, `outbox` | **Legitimate.** §6.3 names exactly these three as the shared recovery tables boot initializes. |
| `app-backup.ts:26` | none (`VACUUM INTO`) | **Legitimate mechanism.** |
| `app-backup.ts:47` | `kernel_writer`, then `messages` and `outbox` at `:43` | **`messages` is a domain table.** Boot reads `MAX(seq) FROM messages` to pick a rehearsal ceiling it already knows as `seq.next` in its own store. Delete `:36-46`, pass the ceiling in. |
| `public-pages.ts:44` | `topics` via `:81`, `:84` | **Delete** (§2.1). |
| `public-pages.ts:139` | `topics` via `:134` | **Delete** (§2.1). |

After 3B, boot's entire knowledge of the app store is the three tables §6.3 says it owns. That is worth turning into a test: `grep -E 'FROM (topics|messages|reads|agents)' packages/boot/src` must be empty. It is the cheapest possible guard against the failure mode that matters here — an agent reshapes a domain table and breaks the one half of the system they cannot edit.

### The app reaching into boot

Two places, one of which should not exist:

- **`GET /_boot/agents`** (`event-http.ts:147`). Entirely derivable from `X-Chirp-Agent`, `X-Chirp-Instance` and `X-Chirp-Label`, which `proxy.ts:299-307` forwards on every authenticated request, plus the `last_seen_at` update §6 already says happens on every request. Delete it; `GET /api/agents` becomes an extension over the app's own table.
- **`GET /_boot/seq`** for the publication fence. Legitimate — only boot knows it — but the app is asking for something boot has already handed it: `events.append` returns `{published_through}` at `events.ts:101` and `:136`. `pr-comments.md` item 10 is right that the per-read call inside the app's SQL transaction should become a cached value advanced from the append response. No boot change needed, which is the point: the fix is in the half that can be edited.

Reading the event log through `GET /_boot/events` is a deliberate deviation in neither direction — §6 states it explicitly as the one channel, and `system.ts` is a consumer like any agent.

## 5. Dependencies

| Dependency | Sites | Verdict |
| --- | --- | --- |
| `effect` 4.0.0-rc.113 | everywhere | **Must stay.** Named in SPEC §7.1. |
| `@simplewebauthn/server` 14.0.1 | `auth.ts:11`, `passkey-management.ts:1`; type-only in `enrollment.ts:1`, `passkey-management-schema.ts:3` | **Must stay.** SPEC §4.2 and `docs/tech.md:166` name it and vendor it into the image. Passkey verification is the whole of "no edit can lock the human out". |
| `@effect/sql-sqlite-bun` 4.0.0-rc.113 | `index.ts:2`, `app-backup.ts:1`, `app-recovery.ts:1`, and `public-pages.ts:2` until §2.1 lands | **Must stay**, and the spec should admit it. `boot.db` is the identity and version store, and boot opens the app store to fence it. This is the dependency the "exactly two" line forgot. The `DbOps` seam in `database-interoperability.md` changes which adapter boot imports, not whether it imports one. |
| `@effect/platform-bun` 4.0.0-rc.113 | `child-keeper.ts:1`, `preparation-keeper.ts:1` only | **Stays, but worth questioning.** Two import lines, for `BunRuntime.runMain` and `BunServices.layer` in the two standalone keeper entries `bun build` emits as separate bundles. The child keeper is 65 lines whose entire job is "hold a pipe, kill a child when it closes, fsync an attempt-bound receipt" — the most load-bearing file in the tree for durability, and the one a human is most likely to read under pressure. Written against plain Bun APIs it would drop the dependency and be readable without knowing Effect. Not urgent; flagged because it is the one place where fewer abstractions buys real auditability. |
| `qrcode` 1.5.4 (+ `@types/qrcode`) | `enrollment-http.ts:59` (SVG for `/approve/:id.svg`), `:72` (ASCII for `qr_ascii`) | **DROP.** Two call sites, and no test in `packages/boot/test` references a QR at all. An ASCII QR renderer in the immutable core is not worth a dependency an agent cannot patch. The approve page already loads `/_boot/auth/approval.js` (`enrollment-page.ts:26`), so the QR can be generated in the browser from the URL that page already has, or as a `data:` URI; the enroll response keeps `approve_url` and `user_code`, which is what the human reads. The cost is specific and small: an agent in a terminal can no longer print a code for the human to scan with a phone, so the phone-only-passkey case goes through WebAuthn's cross-device flow from the laptop — which §4.1 already relies on for exactly that case. Spec edit to §4.1's "the same URL as an ASCII QR" sentence and the §6 `/approve/:id.svg` row. |

## 6. Routes boot actually serves

Dispatch order is `proxy.ts:99-243`. "Dead-app" marks a route that is in boot only because it must answer when no child is running — the bootloader's "way in when everything is broken".

| Route | Source | SPEC §6 | Verdict | Note |
| --- | --- | --- | --- | --- |
| `* /_kernel*` → 403 | `proxy.ts:105` | implied by §7.9 | KEEP | Reserves the child control namespace before any admission. |
| `GET|HEAD /health` | `proxy.ts:107` | yes | KEEP | Dead-app. |
| `GET /_boot` | `proxy.ts:110` | yes | KEEP | Dead-app. Hardcoded help, §7.1 invariant 1. |
| `GET /_boot/seq` | `event-http.ts:61` | yes | KEEP | Boot mints `seq`. |
| `POST /_boot/seq/reserve`, `/_boot/seq/abort` | `event-http.ts:61` | yes | KEEP | Same. |
| `POST /_boot/events/append` | `event-http.ts:61` | yes | KEEP | Same. |
| `GET /_boot/agents` | `event-http.ts:66,147` | **no** | **DELETE** | Derivable from the identity headers; third channel capability where §7.9 names two. |
| `GET /setup`, `GET /auth/login` | `auth-http.ts:187` | yes | KEEP | Dead-app. |
| `GET /_boot/auth/client.js` | `auth-http.ts:182` | yes | KEEP | Dead-app. |
| `POST /_boot/auth/setup/{options,verify}`, `/login/{options,verify}`, `/logout` | `auth-http.ts:191-196` | yes | KEEP | Dead-app. |
| `GET /_boot/auth/passkeys`, `POST .../options`, `POST .../verify`, `DELETE .../:id` | `passkey-management-http.ts:12-16` | yes (§4.2) | KEEP | Credential management. |
| `POST /_boot/auth/challenge` | `enrollment-http.ts:46` | yes | KEEP | The action-bound assertion for all seven sensitive actions. |
| `GET /_boot/auth/approval.js` | `enrollment-http.ts:47` | yes | KEEP | Dead-app. |
| `POST /auth/enroll`, `/_boot/enroll` | `enrollment-http.ts:40` | yes | KEEP | Dead-app. |
| `POST /auth/enroll/:id`, `/_boot/enroll/:id` | `enrollment-http.ts:42` | yes | KEEP | Dead-app. |
| `POST /_boot/enroll/:id/approve` | `enrollment-http.ts:44` | yes | KEEP | |
| `GET /approve/:id`, `/_boot/approve/:id` | `enrollment-http.ts:45` | yes | KEEP | Dead-app, stated in the §6 row. |
| `GET /approve/:id.svg` | `enrollment-http.ts:45,57` | yes | **DELETE the render** | Keep the URL; render client-side. Drops `qrcode`. |
| `POST /auth/refresh`, `/_boot/refresh` | `token-http.ts:11` | yes | KEEP | Dead-app. A live agent must not expire because the app crashed. |
| `POST /_boot/tokens` | `token-mint-http.ts:19` | yes | KEEP (3C: drop) | |
| `POST /api/tokens` (mint alias) | `token-mint-http.ts:19` | **no** | DELETE the alias | §6 aliases only `/api/tokens/:family/revoke`. |
| `POST /_boot/tokens/:family/revoke`, `/api/tokens/:family/revoke` | `token-http.ts:14` | yes | KEEP | |
| `GET /_boot/enrollments`, `GET /_boot/tokens` | `account-http.ts:12-13` | **no** | MERGE to one ~35-line handler | Dead-app, credential management: revoking a family needs its id. Pagination does not. Add the surviving row to §6. |
| `GET /_boot/db/backups` | `backup-http.ts:14` | yes | KEEP | Dead-app. |
| `POST /_boot/db/restore` | `database-restore-http.ts:16` | yes | KEEP | Dead-app. |
| `POST /_boot/db/backup` | — | **missing** | **ADD ~25** | The mechanism half of `scheduled-backup.ts`; the app's cron drives it. |
| `POST /api/topics/<path>/move` | `topic-move-http.ts:26` | §6 puts it in `ext/core.ts` | **MOVE** | Boot keeps the `events.topic` rewrite only. |
| `GET|POST|DELETE /_boot/lock`, `/api/lock`, `DELETE ?break=1` | `edit-http.ts:60-83` | yes | KEEP | Dead-app, the edit loop. |
| `POST /_boot/reload`, `/api/reload` | `edit-http.ts:140` | yes | KEEP | Dead-app, the edit loop. |
| `POST /_boot/revert`, `/api/revert` | `edit-http.ts:85` | yes | KEEP | Dead-app, the edit loop. |
| `GET|PUT|DELETE /_boot/fs/<path>`, `?history`, `POST /_boot/fs/edit`, and `/api/fs/*` | `edit-http.ts:46,153,157,174` | yes | KEEP | Dead-app, the edit loop. |
| `GET /_boot/events`, `/api/events` (long-poll) | `event-http.ts:68` | yes | KEEP | Dead-app, and the §7.6 lock hand-off depends on it. |
| `GET /_boot/stream`, `/api/stream` (SSE) | `event-http.ts:68` | yes | **MOVE** | The only route here whose failure breaks none of the three guarantees. |
| `GET /_boot/status` | `proxy.ts:209` | yes | KEEP, trim | Dead-app. Drop the `storage` breakdown at `:217`. |
| `GET /_boot/generations`, `/api/generations` | `proxy.ts:222` | yes | KEEP | Dead-app. |
| `GET|HEAD /p/**` admission | `proxy.ts:152-159` | §4.3 | KEEP the decision, MOVE the semantics | §2.1. |
| `GET /init`, `/init.md`, `/.well-known/agent.json` passthrough | `proxy.ts:162` | yes | KEEP | Allowlist only; the app serves the bodies. |
| any other `/_boot/*` or reserved prefix → 501 | `proxy.ts:225-243` | — | KEEP | |

**Three spec rows are not implemented, not merely un-audited.** `POST /_boot/restart` (SPEC §6, human) does not exist anywhere in `packages/boot/src` and falls through to the 501 at `proxy.ts:226`. `GET /_boot/metrics` (`docs/tech.md:162`) does not exist. And `POST /_boot/revert {generation, withDb:true}` — the fourth restore in §7.5 — returns 501 at `edit-http.ts:97`, even though `database-restore.ts` now implements the database half. Any honest version of this cut spends some of the saved lines here.

## 7. The order to do it in

**Step 1 — safe now. No guarantee touched, no spec edit, a test already covers every line.**

1. Delete `backup-drill.ts` and the drill branch at `storage-maintenance.ts:32-35`. No test references it; `storage-usage.test.ts` mentions only the scratch prefix. −99.
2. Delete `agent-roster.ts`, the branch at `event-http.ts:147-151`, `/_boot/agents` from the dispatch at `proxy.ts:115` and the internal list at `event-http.ts:66`. `test/event-delivery.test.ts` and `test/agent-presence.test.ts` need edits; the app grows an `agents` row maintained from the identity headers. −37.
3. Delete `app-backup.ts:36-46` (the `messages`/`outbox` ceiling query and the legacy branch) and pass `seq.next` in from `cutover.ts:145`. Delete the JS re-filter at `events.ts:230-249`. `app-backup.test.ts` and `events.test.ts` cover both. −38.
4. Delete `storage-usage.ts` and the `storage` field at `proxy.ts:217`; trim `storage-volume.ts` to the free-space probe. Then **implement the §7.5 budget** — the 5% headroom refusal in the write path, the 20% backup cap, the five-generation snapshot prune. `storage-usage.test.ts` and `storage-status.test.ts` are rewritten. −199, plus perhaps +60 of enforcement that should have been there.
5. Reduce `generation-preparation.ts` to ~95 and `prepared-tree.ts` to `syncPreparedTree`. SPEC §7.1 already describes the simple version ("`bun install` runs into `/data/cache/` against the lockfile"), so this restores the spec rather than changing it; what needs writing down is that the content-addressed store and per-`ext/` installs are the app's or the image build's. `generation-preparation.test.ts`, `extension-preparation.test.ts` and `preparation-deadlines.test.ts` pin current behaviour. −227.
6. Merge the account listings to one handler and add the surviving row to the §6 table. −76.
7. The 462 lines of MERGE work, in the order of the table in §3. The `Record<code,{status,hint}>` step is `pr-comments.md` item 6, already confirmed, so it is a decision rather than a proposal. Covered by `auth-http.test.ts`, `edit-lock.test.ts`, `event-delivery.test.ts`, `tokens.test.ts`, `supervisor.test.ts`, `source-files.test.ts`.

**Step 2 — needs a spec edit, but no new app capability.**

8. The public-pages split (§2.1). Spec edit to §4.3's allowlist sentence. Do it together with `pr-comments.md` item 17, since both touch the gate at `public-pages.ts:131` and the split removes the bug rather than patching it. `pages-http.test.ts` and `kernel-route-guard.test.ts` pin current behaviour. −138.
9. Move the backup schedule: add `POST /_boot/db/backup`, delete `storage-maintenance.ts` and most of `scheduled-backup.ts`, and have the app's cron drive it. Spec edit to §7.1 invariant 7 ("and hourly") to say the app schedules it. `scheduled-backup.test.ts` keeps testing the mechanism. −134.
10. Delete the watcher family. Spec edit to §7.1's watcher paragraph and §7.5's last bullet. `source-observation.test.ts` and `source-tree-undo.test.ts` go. −295.
11. Delete `request-events.ts`. Spec edit to §6.1's "who writes what". Confirm with the owner first; this is the deletion I am least sure about. −73.
12. Move SSE to the app. Spec edit to §6.2's "served by the bootloader, so a swap never drops it". −30.
13. Drop `qrcode`. Spec edit to §4.1 and the §6 `/approve/:id.svg` row. −20.
14. Implement `POST /_boot/restart` and `POST /_boot/revert {withDb}`. Existing spec rows returning 501; these add lines, which is correct for them.

**Step 3 — blocked on the extension write verbs from `pr-comments.md` item 7.**

15. Move topic move to `ext/core.ts`, and with it the page-subtree rename. It needs three things that do not exist: the extension write verbs (`ctx.messages.create`, `ctx.emit`, `ctx.read`, `api.migrate`) so `ext/core.ts` can own a mutation at all; item 5's real HttpApi declarations so the route has a schema when it lands; and a decision on the atomicity loss in §3B item 1. `topic-move-recovery.test.ts` and `topic-page-move.test.ts` keep the boot-side evidence check honest while the coordinator moves. −513.
16. Add the grep test from §4: `grep -E 'FROM (topics|messages|reads|agents)' packages/boot/src` must be empty. This is the invariant the whole audit is protecting, and it is three lines of CI.
