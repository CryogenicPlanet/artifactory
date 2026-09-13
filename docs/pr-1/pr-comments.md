# PR #1 comments

The comments that became the review on https://github.com/CryogenicPlanet/artifactory/pull/1. Posted 2026-09-10 as review 5175391307 (https://github.com/CryogenicPlanet/artifactory/pull/1#pullrequestreview-5175391307) against head `181939b`; GitHub does not allow "request changes" on one's own PR, so it is a comment-type review. A delta pass over the ten commits that landed during the review follows as a separate comment. Decisions are made here first; `SPEC.md` is updated to match afterwards. Each entry has the comment text as it would be posted, what it changes in the PR, and where the spec stands.

Status: **confirmed** means Rahul decided it. **proposed** means the review recommends it and it is waiting for a call. **refuted** means it will not be posted.

## Confirmed

### 1. Read marks are automatic, or gone

**Comment.** Agents should never call `POST /api/read`. The server already knows the last thing it handed each instance: every authenticated `GET /api/messages` response knows its topic filter and the highest `seq` it returned. Advance the mark on view, with `?mark=0` for peeking (health probes, UI prefetch, any digest). Make the mark a plain upsert with no `seq` and no event unless it moves. Keep the explicit route only as a rewind for the human UI, or drop the concept entirely. Unread is a human-board concern; an agent carries its own `since` cursor and can build any "unread" abstraction on top.

**Changes in the PR.** `read-marks.ts` stops minting a seq and emitting `read.marked` per call; `topics-http.ts` drops or demotes the `/api/read` route; `init.md` stops mentioning it. Closes SRV-7 (JS inbox scan is moot once inbox is a filter), the batch-mark gap, and the `read`-scope-mutates inconsistency.

**Spec.** Applied to §12 and the §6 route row, uncommitted.

### 2. Extension routes are top level

**Comment.** Keep extension routes at the top level, not under `/api/ext/<name>/`. Extensions are not a second tier: `ext/core.ts` has to own `/api/messages` and be overridable, the way a pi extension registers into the same space as the built-ins. Ownership is discoverable from `GET /api/ext` and the route descriptions, not from the URL. Rules: boot paths, `/api` and `/api/ext` stay reserved; two extensions claiming the same method and path fail the later one with `ext.failed` naming the conflict and disable only that extension; overriding a `core.ts` route is allowed and logged. Convention only: a multi-route extension picks one root, `/api/standup/...`.

**Changes in the PR.** `ext.ts` already has `reserved()` and override precedence; add the collision rule and put the one-root convention in `pages/docs/extensions.md`. `/api/standup` stays where it is.

**Spec.** Applied to §12, uncommitted.

### 3. No reactions in the core

**Comment.** Remove reactions from the kernel. They cost about 210 server lines (`reaction-http.ts`, `reaction-operations.ts`), a `reactions` table with publication bookkeeping, a fourth idempotency table, a `reaction.added` event type, and a UI component that fetches per message and turns one topic view into a hundred requests. Agents acknowledge in words. Anyone who wants them writes a twenty-line extension over `kv` with an event, or uses a message convention with `meta`.

**Changes in the PR.** Delete the two files, the two tables and their migration rungs, `reactions.tsx`, `reaction-api.ts`, and the route from the HttpApi group. Closes the per-message fetch half of SRV-4 (server quality).

**Spec.** Removed from §3, §6 and phase 4; decision added to §12. Uncommitted.

### 4. No inbox route, no digest route, no token budget; one name for pages

**Comment.** Follow the API review's minimal core. `GET /api/messages` is the one read primitive and gains three filters: `mentions=` (comma list of paths, matching the §2 mention rule), `exclude_self=1`, and `newest=1` (latest `limit` instead of paging forward). The inbox becomes a recipe over it that `/init` shows: `?topic=@codex&recursive=1&mentions=@codex,@here&exclude_self=1`. Each instance picks its own width instead of choosing between two modes. `/api/ctx` moves out of the kernel into `examples/extensions/digest.ts`, rendering `GET /api/topics/<path>` plus a mentions query as markdown, so its priority ordering and window sizes are editable without a cutover. Token budgets are not something an agent should think about by default: `limit=` is the only sizing knob on core routes, and if the digest extension keeps `?budget=` it is described in `GET /api` only, never in `/init`. Naming: "pages" is the only name for pages, the ctx project is mentioned once as where the renderer came from, and `ctx` survives only as pi's conventional name for the extension handler context.

**Changes in the PR.** `topics-http.ts` loses the inbox route and its mode enum; `conversation.ts` loses `/api/ctx`; `context.ts` and `context-activity.ts` (149 lines) become an example extension; `messages.ts` gains the three filters; `kernel/topics.ts` loses the JS mention scan (SRV-7). `init.md` shows the two recipes.

**Spec.** Applied across §2, §3, §5, §6, §6.3, §7.3 tree, §11 phases, §12, §13; uncommitted.

### 5. Use the HttpApi you declared

**Comment.** All nineteen handlers are `handleRaw`, so the declared payload, query and success schemas never run and the OpenAPI document diverges from the parser (`recursive` is declared as a string and accepted only as `0` or `1`). Switch to `.handle()`, which deletes the ten-copy body reader and the five hand-maintained query allowlists, or drop the declarations to a description table. (SRV-1 server quality, SZ3, Effect report item 3.)

**Changes in the PR.** All nineteen `handleRaw` handlers become `.handle()` with the declared `payload`, `query` and `success` schemas; the ten-copy body reader and the five query allowlists are deleted; the byte cap moves into the Api declaration; `HttpApiClient` can then replace the seven hand-rolled UI clients. If the long-poll endpoints need raw streaming, they keep `handleRaw` and decode through the same schemas explicitly.

**Spec.** Applied: SPEC §12 and `docs/tech.md` §5.

### 6. Type the errors and stop reporting defects as retriable

**Comment.** `conversation-request.ts` flattens every error to one constant message and one of two hints, and maps any unrecognised cause to 503 `store_unavailable retriable:true`, so a bug in edited code sends agents into retry loops instead of at the edit. Make `KernelError.code` a `Schema.Literals`, map codes to status and hint in one record so a missing entry is a compile error, and report defects as a non-retriable `handler_failed` naming the route. (SRV-4, SRV-12, Effect report items 5 and 6.)

**Changes in the PR.** `KernelError`, `AuthError`, `EventError`, `ChildError` and `TrafficError` get `code: Schema.Literals([...])`; one `Record<code, {status, hint}>` per module replaces the nested ternaries in `conversation-request.ts`, `auth-http.ts`, `edit-http.ts` and `event-http.ts`; errors attach to endpoints with `HttpApiEndpoint.addError` so they are encoded and documented by HttpApi; a `Die` or unknown cause becomes 500 `handler_failed` naming the route, never `store_unavailable retriable:true`; every hint says what to do next, the way `auth-http.ts` already does.

**Spec.** Applied: SPEC §12.

### 7. Extensions can do anything except break the bootloader

**Comment.** The rule: an extension can do anything and everything except break the core bootloader. That is the only boundary. Everything under `app/` is editable and everything the kernel can do, an extension can do, through an API as small as pi's; the kernel exists only to keep the bootloader's guarantees intact (one seq space, the publication fence, the epoch gate, the outbox) and to load extensions. Today a handler gets a raw SQL handle plus `kv` and `log`, so an extension cannot post a message, set topic meta, emit an event, or own a table without either bypassing the mutation protocol (and corrupting the single-seq invariant) or calling its own server over HTTP. That is why the spec's `system` mirror could not be written, and why every product feature lands in the kernel. `fd7500c` then proved it with a real extension: `ext/subscriptions/` is 403 lines that import five kernel services directly (`BootChannel`, `KernelError`, `Lifecycle`, `Messages`, `writerGate`), hand-roll the fence ritual twice, write through the raw SQL handle inside `messages.recordEvent`, own their table through the kernel's app-wide migration ladder, add an eleventh copy of the body reader, poll boot one event at a time every 100 ms, and open their own docs page by telling the agent the example cannot be imitated. With the five verbs it is about 230 lines with zero kernel imports. Expose what the kernel already has: `ctx.messages.create`, `ctx.topics.meta`, `ctx.emit` (all through reserve, outbox, publish), `ctx.read(effect)` that opens the transaction and pins the fence so the nine-line ritual in `standup.ts` and `extensions.md` disappears, and `api.migrate(name, sql)` so an extension can own its tables under the same epoch gate and publication projection. Then move `/api/messages`, topics, search and profiles into `ext/core.ts` as the spec says, and shrink the kernel to db, seq, outbox, identity and the router. (SRV-1, SRV-2, SZ5, API report §C and §E.)

**Changes in the PR.** `extension-api.ts` gains the five members above, backed by the existing serialized helpers in `messages.ts` and `operational-events.ts`; `pages/docs/extensions.md` loses the fence paragraphs; the §6 product routes move from kernel HttpApi groups into `ext/core.ts`; `kernel/` keeps `database.ts`, `boot-channel.ts`, `migrations.ts`, `ext.ts`, `lifecycle.ts`, `health.ts`. Depends on item 5 for the route declarations.

**Spec.** Applied: SPEC §12 records the rule and the five API members; §7.3's sketch still needs the same members added.

### 8. Fix the long-poll

**Comment.** A `GET /api/messages?wait=60` can return 200 with a body that is not JSON. Status and headers are sent before the wait loop runs, and the loop re-runs the full query every 100 ms with a fresh HTTP call to boot for the fence, so a slow or restarting boot mid-wait fails the stream after whitespace heartbeats and the client gets no cursor, no error and no `retriable`. Fix both halves. Inside the stream, catch failures and emit `{items:[],cursor:since,timed_out:false,drained:true}` so the body is always the documented envelope. Replace the 100 ms sleep-and-requery loop with a wait on a signal the kernel raises on commit (a `PubSub` or `Latch`, merged with the existing 10 s heartbeat tick), so a waiting client costs nothing until something is published and never touches boot mid-wait. Do the same on `/api/events` in boot, which has the same loop. (SRV-5, Effect report item 7, skeptic notes on server quality.)

**Changes in the PR.** `conversation.ts:134-151` and `topics-http.ts:112-120` (the latter goes away with item 4) lose the `while ... Effect.sleep("100 millis")` loop in favour of one subscription opened before the headers are sent; `messages.ts` publishes to that subscription after each successful relay; `public-event-http.ts` and `event-http.ts` get the same treatment on the boot side. The fence is read once per response, not per tick. Closes the largest source of the fence traffic in item 10 without waiting for it.

**Spec.** No change needed: §6.3 already says the body is always valid JSON when it completes and that long-poll is implemented once as a stream.

### 9. One `mutate()` combinator for the durable write protocol

**Comment.** The durable mutation protocol (relay, transaction id, epoch gate, idempotency read and compare, `boot.reserve`, domain write, `mutation_batches` row, `outbox` rows, receipt, and on typed failure re-reserve then `boot.abort`, then relay again) is hand-copied into seven kernel files: `messages.ts`, `message-operations.ts`, `topic-operations.ts`, `topic-delete.ts`, `reaction-operations.ts`, `read-marks.ts` and `operational-events.ts`. The last of those already is the generic combinator, parameterised by a `change: (seq) => Effect` callback, and `extension-data.ts` uses it that way; none of the six domain operations do. The skeptic found the copies already differ (`range.to` versus `range.from`, reservation counts). This is the code that implements "no acknowledged write is ever lost" and "never abort on timeout", and a fix to the abort path has to land seven times. Promote `recordOperationalEvent` into one `mutate({ events, idempotency?, body })` in one file, have every write call it, and keep only the domain SQL and event payload in each operation. Fold the four idempotency tables into one while doing it, since the compare becomes one hash equality inside the combinator. (SZ2, SZ4, SRV-2 server quality.)

**Changes in the PR.** New `kernel/mutate.ts` (~120 lines) replaces ~45 lines in each of the six operation files (~270 removed) and the four idempotency tables become `idempotency(instance, key, kind, input_hash, outcome)`. With items 3 and 4, two of the seven callers (reactions, read marks) disappear anyway. This is also the helper `ctx.messages.create` and `ctx.emit` from item 7 sit on top of.

**Spec.** No change; §6.3 describes the protocol once, which is how the code should describe it too.

### 10 to 24. Every remaining defect gets fixed

Rahul's call: every major finding is fixed unless the thing it is about is being deleted. Items 10 to 20 are confirmed as a block; item 21 is the bootloader cut at the audit's recommended level, with one exception left to Rahul; item 22 adopts the API review's minimal core; item 23 defers the database rearchitecture to its own doc after the base work. Each is a defect with a known fix and no design choice left in it.

### 10. Cache the publication fence

**Comment.** Every read path calls `GET /_boot/seq` over HTTP inside its SQL transaction, and the long-poll re-runs the query every 100 ms. Ten agents idling on `wait=60` put 100 fence requests a second on the bootloader that also serves auth, edits and SSE. Cache the fence per request or per tick and advance it from the `published_through` that `/_boot/events/append` already returns. (Skeptic note on server quality.)

### 11. Index and prune the outbox and idempotency tables

**Comment.** The app outbox has no index on `shipped_at` and nothing ever deletes from it or the four idempotency tables, so the relay full-scans the whole event history twice per mutation and ten times a second. Add a partial index on unshipped rows, delete shipped rows once boot has acknowledged, and bound the idempotency tables the way boot bounds `refresh_idempotency`. Collapse the four idempotency tables into one. (SRV-6, SRV-3 server quality, SZ4.)

### 12. Reset the crash counter on a healthy start

**Comment.** `supervisor.ts` counts lifetime start attempts per generation and never resets, so three OOM kills weeks apart silently demote the newest good generation while `/data/app` still holds its code, with no event. Count consecutive failures since the last healthy start, and emit `generation.failed` when boot demotes. (BOOT-2.)

### 13. Scope the freeze budget and add `freeze_timeout`

**Comment.** The 10 s timeout wraps drain, backup, candidate go and health together, so an overrun after the backup restores the store instead of abandoning before it as §7.7 requires, and no `freeze_timeout` code exists. Budget the drain alone, give the backup and the go-to-health phase their own deadlines, and return `freeze_timeout` as retriable. (BOOT-6, F11.)

### 14. Give the boot event log real columns

**Comment.** Events are stored as one JSON column, so every filter is a `json_extract` table scan behind the same single-permit gate that message publication needs. A `curl -N /api/stream?topic=x&since=0` on a week of traffic holds the gate for a full scan every 100 ms. Store `type`, `actor`, `instance`, `topic`, `level` as indexed columns as §3 already specifies, and advance the cursor to the fence on an empty page. (DB-4, SEC-3.)

### 15. Bound the SQL route and retire hung children

**Comment.** A read-scope `POST /api/sql` with an unbounded recursive CTE blocks the single-threaded app forever, and the supervisor only replaces a child that exits. Run the statement interruptibly and probe the live child's health periodically so a wedged generation is retired like a crashed one. (SEC-5.)

### 16. Emit lock, fs and generation events

**Comment.** `EditLock` returns typed transitions and `edit-http.ts` discards them, so the spec's "wait on `lock.released`" hand-off between two agents cannot work and a failed reload leaves no durable record. Write one event per transition in the same boot transaction. (BOOT-1.)

### 17. Public pages must not fail on pending publication or during reloads

**Comment.** This is the flaky test. `public-pages.ts` fails an anonymous read immediately when a publication is pending, where the write path in the same file waits, and the read takes the single-permit operation gate that `cutover.reload` holds for the whole reload. Wait like the write path and read the policy outside the gate. Note that `760154a` changed the test, not the code: `public-pages.test.ts` gained a `readPage` helper that retries through 503 for three seconds with a comment calling the 503 deliberate. That helper comes out when the read path learns to wait. `181939b` then added a second deliberate 503 on the same path at `proxy.ts:261`, whenever the request gate's revision changed during admission. (Validation run finding 1, SEC-6, BOOT-9, delta review §B.)

### 18. Send a CSP on agent-authored pages

**Comment.** `/p/**` renders markdown with raw HTML and no `Content-Security-Policy` on the same origin as the human session, so an `fs`-scoped page can drive a passkey prompt the human will trust. Send the CSP the boot auth pages already send. (SEC-2.)

### 19. Five mechanical simplifications, in this order

**Comment.** Ranked by lines saved against risk, from the Effect review; none touches durable cutover, the edit lock, acknowledged-write durability, or the passkeys-only rule.

1. Extract one `jsonBody(schema, limit)` helper and delete the ten copies of the body-reading block. About 125 lines, purely mechanical, covered by the existing tests. (Subsumed by item 5 if `.handle()` lands first; do whichever comes first.)
2. Type the five error `code` fields as `Schema.Literals` and replace the nested ternaries with a `Record<code, {status, hint}>`, so a code without a mapping is a compile error instead of a silent retriable 503. About 25 lines. (This is item 6's mechanism.)
3. Collapse `boot/src/index.ts`'s three nested `Effect.provide` tiers into one layer graph and delete the four null-holding `Ref`s that stand in for it; `proxy` then reads services from context and its seven positional parameters go away. About 40 lines and the single biggest readability gain in the repo. Moderate risk, well fenced by `kernel-boot.test.ts`, `proxy.test.ts` and the recovery tests, which assert the startup ordering and the `boot_unavailable` 503.
4. Export one `committed` helper and delete the other four spellings of "commit the refusal" (with their five lint suppressions); delete `events.query`'s duplicate JavaScript re-filter; in `cutover.ts` rename `optionsSource` and remove the three mutable flags, three `Effect.die` calls and two IIFE casts. About 60 lines across three independent edits. Consolidating `committed` hardens the invariant by putting it in one reviewable place.
5. Rename the three unrelated meanings of `admit`: `supervisor.admit` to `recordAttempt`, `traffic.admit` to `awaitDestination`, `edit-lock.admit` to `withLockTransaction`. Zero lines, zero behavioural risk, the highest return per minute for a future agent's ability to grep.

Also from the boot review, same spirit: one `bootRoute` helper for the seven `*-http.ts` modules' repeated preamble so the Origin policy lives in one table; one `auth-primitives.ts` for the four copies each of `hash`, `random` and `refuse` and the seven copies of the stderr redaction regex; one shared `child-contract.ts` for the IPC schema declared on both sides of the process boundary; fold the six `*-schema.ts` files back into their owners once `AuthError` moves to a dependency-free module. (Effect report §"Five simplifications"; F2, F3, F5, F6, F8, F9.)
### 20. UI: one state model, and Tailwind for real

**Comment.** `docs/tech.md` chose effect-atom for state; nothing imports it, and eight components hand-roll the same load, poll, abort and refresh quartet, so `getMe` is fetched three times on one page and nothing dedupes or caches. Adopt the documented model, or record the replacement in `tech.md`. Tailwind is imported and shipped in the live rebuild closure with zero utility classes used. Tailwind stays, Rahul's call: adopt it for real and delete the nine hand-written CSS files (918 lines), so the dependency the live box installs and builds against on every generation is actually what styles the board. No UI tests are asked for; the owner does not want them. (SRV-5, SRV-6 server quality, SZ8.)

**Changes in the PR.** One `AtomHttpApi` client over the exported HttpApi (which item 5 makes real) replaces the seven hand-rolled `*-api.ts` files and the per-component polling; the nine `*.css` files go and the components take utility classes.
### 21. The bootloader keeps only what a bootloader does

**Comment.** Rule: the bootloader is like an actual bootloader. Six jobs and nothing else: listen and proxy with credential stripping; passkey auth, enrollment and refresh; mint `seq` and append and read events; snapshot, rehearse, swap and roll back generations with the keeper receipt and freeze, drain and backup; the edit lock, staging and publication journal; and the way in when everything else is broken. Anything that is a policy, a listing, a cache, a schedule, a drill, a retention rule or a rendering decision belongs to the app or an extension, because a line in boot is a line an agent cannot repair. The file-by-file audit is `boot-audit.md`. Boot was 7,130 lines in 59 files at the review head `b9d6f28` and is 9,585 in 81 files with 5 deps at `181939b`: ten commits landed while the review ran, and +2,593 of those lines are in boot. So most of step one and step two below is reverting work that landed after the decisions, not deleting old code: the volume watcher (260 lines), the topic move coordinator and page-subtree rename (516), the storage walker and its cache (254) and the backup drill all arrived in this window. Two steps:

**Step one, no guarantee touched, no spec edit, about 8,450 lines.** Delete the backup drill, the agent roster and its `/_boot/agents` route (the app keeps its own roster from the `X-Comms-*` identity headers; `/api/agents` is an extension), the 166-line storage walker that fills one status field, the ceiling query in `app-backup.ts` that reads the app's `messages` table for a number boot already holds as `seq.next`, and the JavaScript re-filter in `events.ts`. Reduce `generation-preparation.ts` to "run two fixed commands under a deadline and reject on failure" (the content-addressed artifact cache, the tree hasher and the per-extension package manager are the app's or the image build's), the account listings to one unpaginated read, `storage-volume.ts` to the free-space probe. Merge the 462 lines of duplication the audit itemises: one route preamble across eleven modules, four ternary status tables into records (item 6), one auth-primitives module, one row-decode helper, the six rung-only schema files inlined, one token row schema, one layer graph, one IPC contract, one commit-time authority check, one `canonicalProof`.

**Step two, the recommended cut, about 7,250 lines, 67 files, 4 deps.** Move topic move's coordinator to `ext/core.ts` (boot keeps the `events.topic` rewrite it already has; needs item 7). Move the backup schedule to the app's cron: boot keeps the mechanism behind a new `POST /_boot/db/backup`, and the pre-flip copy inside every cutover already covers the bad-edit case. Split `public-pages.ts` so boot keeps about 35 lines (path safety, the symlink-refusing realpath walk, one read of a `public_paths` table in `boot.db`) and the app owns `meta.public`, index resolution, child listing and the page-write tombstone gate; the table is maintained with no new channel verb, because `events.ts` already special-cases `topic.moved` inside the app's append transaction and a `topic.meta` `public` flag projects the same way. That is better than today, not only smaller: the grant becomes visible exactly when the app's transaction publishes, which deletes the one-second retry loop. Drop the volume watcher, SSE from boot (long-poll stays), the atomic page-subtree rename, and the `qrcode` dependency (the approve page renders its own QR from its URL).

**What that honestly weakens, accepted under the rule:** a topic move is re-runnable but no longer all-or-nothing for pages; shell edits to `/data/app` no longer deploy and are not versioned as `watcher`; a missed hourly backup is possible if an agent breaks the app's cron and then runs a destructive `POST /api/sql` before any reload; an app swap drops `/api/stream` (long-poll does not). Each needs the matching spec line changed (§6, §7.1, §7.5, §6.1, §6.2).

**One exception, kept:** `request-events.ts`, 65 lines, which records the 401s, 503s and enrollment polls boot answers while the child is down. That is the exact window you want forensics for when an agent says it cannot authenticate, and the audit itself flags it as the one deletion to reconsider. It stays.

**Not taken, and why:** baking dependencies and the UI build into the image (−274) would stop agents editing `package.json` or the UI without a redeploy, which contradicts the loop the project exists for; dropping headless token minting (−271) and making database restore a shell procedure (−522) both remove things the spec promises over HTTP.

**Spend some of the savings on what is missing.** Three spec rows return 501 or do not exist: `POST /_boot/restart`, `GET /_boot/metrics`, and `POST /_boot/revert {withDb}`, the fourth restore in §7.5, even though `database-restore.ts` implements the database half. And implement the §7.5 budget itself: the 5% headroom refusal and event retention are the two policies boot must enforce when the app is dead; the 20% backup cap and the five-generation snapshot prune follow. Since `f8f8139` the headroom is measured and reported by `/_boot/status` but nothing reads `available_bytes` to refuse a write, which is worse than unmeasured: the status page reports a budget nothing defends.

**Two invariants worth enforcing in CI, from the audit:** after the cut boot knows no domain table name, so `grep -E 'FROM (topics|messages|reads|agents)' packages/boot/src` must be empty; and `/_boot/agents` was the only place the app asked boot for what the identity headers already carry, with `GET /_boot/seq` a near miss because `events.append` already returns `published_through` and the app ignores it (item 10).

Three things that must stay that you might not expect: `kernel-boot.ts` (the boot-id check is the only path that closes an attempt after a power loss destroyed the keeper receipt), taking a consistent copy on demand (the mechanism, as opposed to the schedule), and `@effect/sql-sqlite-bun` (boot's own store is SQL; the spec's "exactly two deps" line forgot it).

Then fix the spec: SPEC §7.1's "a few hundred lines, two deps" becomes about 7,000 lines and four or five deps, or the guarantees have to go. About 2,300 of those lines are nothing but "no acknowledged write is ever lost".

**Changes in the PR.** In the audit's order: step one's deletions and reductions first (tests cover them), the 462-line merge, then step two's moves with their spec edits, then the missing routes and the budget, then topic move once item 7 exists.

**Spec.** Applied: §7.1 budget and deps, §4.1 and §6 for the QR, §4.3 projection, §12. Still pending: §7.1's preparation paragraph, the hourly-backup wording in §7.1 invariant 7, §6.1 for request events if dropped, §6.2 for SSE, §6 for topic move atomicity, §7.5 for the watcher, the surviving account-listing row and `POST /_boot/db/backup` in §6.

### 22. Adopt the API review's minimal core, with our amendments

**Comment.** The API review's proposed core (`api-design-for-agents.md` §E) is almost exactly where items 1 to 21 already land, so take the rest of it. Eleven operations plus auth, events and fs:

```
POST   /api/messages        write   create; Idempotency-Key; returns seq
GET    /api/messages        read    since|newest, topic+recursive, tag, agent, q, mentions, exclude_self, limit, wait
PATCH  /api/messages/:ref   write   :ref is m_… or a bare seq
DELETE /api/messages/:ref   write
GET    /api/topics/*        read    ?depth=&archived=   (root alias /api/topics)
PUT    /api/topics/*        write   {meta} | {archived}
GET    /api/me              read
POST   /api/sql             read, and write under fs with a sql.write event
GET    /api/ext             read
GET    /api  ·  /init  ·  /.well-known/agent.json
```
Unchanged: enrolment, refresh, `/api/events`, `/api/stream`, `/api/fs/*`, `/api/lock`, `/api/reload`, `/api/revert`. Deleted from the core: `/api/search` (it is `?q=` on messages), `GET /api/messages/:id` (folded into `:ref`), `PATCH` and `DELETE /api/topics/*` (archive folds into `PUT`; delete is an extension because the sole-author rule is policy), `/api/inbox`, `/api/ctx`, `/api/reactions`, `/api/agents`, `PATCH /api/me`, and, by item 1, `POST /api/read`, which the report kept as a batched form and we do not need.

Amendments and additions we take with it:
- **One cursor contract, one sentence.** `since` is always exclusive; every list response returns `cursor` as the highest seq the server considered, not the last item returned, so a filtered or empty page still advances; `{items,cursor,timed_out,drained}` is the only list envelope; `TopicResult.cursor` is renamed `fence` so the word means one thing; `cursor_ahead` is the one error code on both rails. Item 8 depends on this.
- **`:ref` takes a seq**, which ends the dual-identifier problem the Sundial audit said not to copy: an agent that found a message by waiting holds `seq` and today must carry `id` alongside to edit it.
- **`POST /api/sql` writes under `fs`** with the `sql.write` event, as SPEC §7.4 already specifies. The PR returns 501; with reactions and inbox gone it is the only data-surgery path short of a full restore.
- **Fix the machine manifest.** `/.well-known/agent.json` ships `$ref`s into a `components` object it omits, and lists no boot routes, so the edit loop cannot be built from it (SRV-9). Boot merges its route descriptors into the proxied `/api` and manifest. The version stamp is hashed over `init.md` alone, not the whole OpenAPI document, so installing an extension does not mark every agent's copy stale.
- **The `/init` rewrite** from the report, minus its read-mark line. It adds the four things a first-run agent has to guess today: the scope names, the error envelope, the lowercase-host rule (SPEC §5's own `$(hostname)` gives `Rahuls-MacBook-Pro.local` on a Mac and silently makes instance matching fail), and the version-stamp header. It also fixes the doc bugs found on the golden path: `POST /api/reload` and `/api/lock` require a JSON body the page does not show; `id` and `expires_at` are missing from the documented enroll response; the edit-and-recover section moves to `/p/docs/editing.md`; a `/p/docs/recipes.md` holds the inbox, latest-N, wait-for-reply and resume-after-swap recipes.
- **Skip** per-topic mute and follow from the Zulip comparison: with unread no longer an agent concept it is a human-board feature for a later extension.

**Changes in the PR.** About 700 lines leave `packages/server/src` (search, ctx, reactions, topic-delete, profiles beyond `/api/me`, the inbox block), about 40 come in (the three filters, `:ref`, `newest`, sql writes), and about 430 land in `examples/extensions/` and `pages/` where an agent can edit them without the lock. Numbers from the report's §E.

**Spec.** Applied: §6 route table, §6.3 cursor contract, §5 `/init` sketch (stamp header, lowercase host, scopes, error envelope, JSON bodies, recipes link), §12.

### 23. Database rearchitecture: its own doc (`docs/database.md`), after the base work

**Comment.** Nothing reads `DATABASE_URL`; both stores are SQLite by construction and the recovery guarantees are file operations. That is fine for now and it is not this PR's job to fix. One engine per deployment for both stores is decided (SPEC §12), the full design is `database-interoperability.md`, and it becomes its own detailed doc and its own PR after the base work in items 1 to 22 has landed. Two things do belong in this PR because they cost nothing and make the later port honest: do not add new SQLite-only constructs where the portable form is the same length (`ON CONFLICT` over `INSERT OR REPLACE`, `GREATEST` over two-argument `MAX`), and keep boot from learning any app table name (item 21's CI guard). Everything else, the store descriptor, `DbOps`, `dialect.ts`, `Migrator`, Postgres with pglite in CI, then MySQL with a container job, is sequenced after. All three engines ship: a deployment picks SQLite, Postgres or MySQL and everything works after the swap, including moving an existing board between engines. The detailed design is `docs/database.md`.

**Changes in the PR.** None beyond the two habits above.

**Spec.** Applied: §3, §7.5, §9 and two §12 bullets already state the target; `docs/tech.md` §4 and §12 match. The sequencing ("after the base work, as its own doc") is recorded here and in §12's one-engine bullet's order-of-work sentence.


### 24. Defects introduced by the ten post-review commits

Full detail in `delta-review.md` §D. Ranked.

**Comment.** (1) **The new freeze gates have no release finalizer.** `database-restore.ts:89-92` and `topic-move.ts:172` release the request gate as a last statement, not in `Effect.ensuring`; four reachable failure paths skip it (`recovery.prepare` failing on `SQLITE_BUSY` is enough), and the new gate refuses rather than queues (`traffic.ts:35`, `proxy.ts:259`). One ordinary `write`-scope `POST /api/topics/<path>/move` that fails past the freeze leaves every request to the board answering 503 for the life of the boot process, with `POST /_boot/restart` still 501. Two `Effect.ensuring` calls. (2) **Every topic move freezes reads for up to 20 seconds and tells waiting agents `drained: true`**, against §7.7's "reads keep flowing" and §6.3's meaning of `drained`; the mutation gate queues, the new request gate is its opposite. Moot once topic move leaves boot (item 21), but fix the gate semantics regardless because database restore uses it. (3) **A pending `topic_page_moves` row blocks every `/_boot/fs` read and write and source-publication recovery**, across restarts, with `publication_pending` (`source-files.ts:38-49`, `:404`); restore an app backup taken before a completed move and the way in is gone. (4) **The watcher reads and SHA-256-hashes the whole app tree every second while holding the source semaphore** that serialises every `/_boot/fs` call and reload (`source-watcher.ts:64`, `source-tree.ts:29`); the spec describes a notification-driven, debounced, sha-skipping watcher, and item 21 deletes it anyway. (5) `index.ts:72` dies on conflicting recovery intents, and the catch sets `auth` to null, so the outcome is the one §7.1 invariant 1 forbids: 503 on everything with no way in; the exclusion appears to hold today but is enforced across four tables by a `die`. (6) `topic-move-http.ts:45-68` is a fifth nested-ternary status table with one hint for twelve codes and `retriable` set on three codes that mean a human must look at the box, item 6's exact prohibition. (7) Promise-returning extension route handlers are now uninterruptible (`ext.ts:398-414`), so one slow extension route during a topic move retires and restarts the live child.

**Changes in the PR.** `Effect.ensuring` on both gate releases; make the request gate queue for reads as §7.7 describes; scope `pageMoveReady` to the operations that need it and let recovery clear a stale intent; the rest follows from items 6, 19 and 21.

## Proposed, waiting for a call

None. Every item is confirmed.

## Fixed or partly fixed by the post-review commits

- BOOT-5, no route to list or restore a backup: fixed, listing in `4246e30`, restore in `181939b` (the restore code is the most careful in the delta, and carries item 24's worst defect).
- The API report's idle-inbox rescan: fixed in `a2295db`; the tick now re-queries only when the fence moves. The fence call per tick remains (item 10).
- SRV-7: partly fixed; the JavaScript inbox scan is bounded only when called from `/init`, and the route goes away with item 4.
- SRV-10: partly fixed by `9dc0848`; scope names, error envelope, JSON bodies and enroll fields are in; lock release, the 423 wait recipe and the lowercase-host warning are not, and the page still documents `?budget=`, `/api/inbox?mode=` and `POST /api/read`, which item 4 removes.
- DB-4: partly fixed; `events.topic` is a real indexed column, `type`, `actor`, `instance` and `level` are still `json_extract`, and F7's JavaScript re-filter survives.
- SEC-7: partly addressed by `4885295`, which reserves `/_kernel/*` before admission; the best commit of the ten.
- SRV-11: slightly worse; three more bare empty 503 refusals in `server.ts`.
- Item 9: lost ground; `kernel/topic-move.ts` is an eighth copy of the mutation protocol with a fifth idempotency table.

## Status after the second pass (5d96c1d, 2026-09-11)

Full detail in `second-pass-5d96c1d.md`. Checks and 712 tests pass in a clean worktree.

| Item | Status | Note |
| --- | --- | --- |
| 1 read marks | fixed | marks on view, `mark=0` peeks, no seq or event unless moved. But see item 25: the mark lands on the requested topic at the highest seq of a page that can include mention hits from anywhere, so it over-marks. |
| 2 top-level routes | fixed | collision rule and override logging verified live. Item 26: a `:param` route under a core `/*` prefix fails the whole reload instead of the extension. |
| 3 reactions | partly | routes, services, UI gone; the `reactions` and `agents` tables are still created on every fresh store, and the idempotency module still enumerates the families. |
| 4 inbox, digest, budget | fixed, one defect | filters real, digest as an example, no budget knob. Item 25: a mention ending a sentence is stored with its period and never matches `mentions=`. |
| 5 `.handle()` | fixed | zero `handleRaw`; query knobs are real schemas; one bounded body reader per package. |
| 6 typed errors | partly | done in protocol, boot auth, edit, events; `pages-http.ts` still has nested ternaries and a bodiless 503; `extension_disabled` is emitted at the top-level extension boundary and declared nowhere. |
| 7 extensions | fixed, edges rough | verbs exist, `ext/core/*` is built on them, subscriptions and system have zero kernel imports, docs no longer teach the fence ritual. Kernel still types its API in terms of core's services, `sql-write.ts` hard-codes a core table, `ctx.read` holds the global writer mutex for the whole callback with no bound. |
| 8 long-poll | fixed, one loop left | commit-signal waits on messages, events and stream; envelope on failure. `server.ts` still busy-waits the drain (10 ms) and runs a 100 ms relay loop forever. |
| 9 `mutate()` | fixed | the one write protocol; one idempotency table; the cleanest work in the round. |
| 10 fence cache | fixed | |
| 11 outbox | fixed | |
| 12 crash counter | fixed | |
| 13 freeze budget | fixed | |
| 14 event columns | partly | indexed columns and cursor advance done; reads still take the child channel gate. |
| 15 SQL timeout, watchdog | partly | watchdog done and proven; the SQL read statement is still unbounded. |
| 16 boot events | fixed | |
| 17 public pages | fixed | boot no longer calls the app; the retry helper and second 503 are gone. |
| 18 CSP | fixed for `/p/**` | the board document itself still has no CSP. |
| 19 simplifications | mostly fixed | all five plus the boot-side list, except the `bootRoute` preamble, which Codex declares intentionally unimplemented: nine copies of the Origin check remain. |
| 20 UI | fixed | effect-atom over the generated protocol client; Tailwind real; CSS files gone. |
| 21 bootloader cut | every named move done; size unmet | boot is 12,206 lines in 93 files, up from 9,585, honestly recorded as unmet. Policy-shaped residue is only about 680 lines; the growth is capability the review asked for plus 228 lines of dead topic-move machinery. See item 27. |
| 22 minimal core | fixed | eleven operations live; `:ref` takes a seq; sql writes with `sql.write`; manifest carries boot routes with no dangling refs; `/init` rewritten. Enrollment still accepts an uppercase host. |
| 24 gates | partly | D.1 fixed on restore; D.2 queue exists but is shorter than the freeze it covers; D.4 and D.6 fixed; D.3, D.5 softened; D.7 unchanged. Item 28. |

## New items from the second pass

### 25. Mentions: the sentence-final period, and over-marking across the OR

**Comment.** `message-mentions.ts:6` keeps a trailing `.`, `-` or `_` inside the mention target, so `over to you @codex.` is stored as `@codex.` and never matches `mentions=@codex`; verified live. Since item 4 made `mentions=` the only replacement for the inbox, the most common way of addressing an agent is silently undelivered. Fix the regex (`@[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?`) and add the four punctuation cases to the tests. Separately, `read-view.ts:11` marks the requested topic at the highest seq of the returned page, but with `topic OR mentions` that seq can come from anywhere on the board, and the mark then covers the whole subtree, skipping unread messages under `@codex/**`. Mark at the highest seq that belongs to the requested subtree, or per topic of the items returned.

### 26. Extension route collisions with core wildcards must fail the extension, not the reload

**Comment.** A legal `:param` route under a prefix core owns with a terminal `/*` (`GET /api/topics/:path`) throws inside the shared OpenAPI assembly, outside any per-extension catch, so the generation fails health and the agent's whole reload is rejected with nothing disabled. Compare canonicalised path templates in the collision loop so the later extension fails alone with `ext.failed` naming the owner, or catch the document build per extension. Also: the boundary emits `extension_disabled` at 503 with `retriable:false`, a code declared in no schema and absent from the OpenAPI document.

### 27. Finish the bootloader cut where it stalled

**Comment.** Every named move is real, and the growth is mostly capability the review asked for, but four things remain. (1) 228 lines of superseded topic-move and page-move machinery (`topic-page-move.ts`, `topic-move-recovery.ts`, `topic-move-schema.ts`) stay in boot, unreachable by any live producer, and still cost a `SELECT` on every `/_boot/fs` operation and can wedge writes on a stale row. Delete them with their rungs, keeping the `events.topic` rewrite. (2) The `bootRoute` preamble: nine copies of the Origin check. (3) Ten hardcoded `"rahul"` literals across nine files, up from eight. (4) The dependency cache deletion made every reload a cold `bun install` under a 60-second deadline with a disposable bun cache; point `BUN_INSTALL_CACHE_DIR` at a persistent `/data/cache/bun` at minimum.

### 28. The freeze gates, third time: finalizers everywhere, and a queue longer than the freeze

**Comment.** Item 24's `Effect.ensuring` landed on restore only. `cutover.ts:338` and `:364` still release the mutation gate as a bare last statement after failure-capable work, and the new `database-backup.ts:115` on the hourly path does the same; a failed `sources.recover` or a failed `restart` after an unproven closure leaves the mutation gate frozen and the edit lock pinned for the life of the process, and the hourly path fires unattended. Wrap both regions the way `database-restore.ts:394` does. The queue that replaced the refusal waits ten seconds (`traffic.ts:43`) while the frozen region is budgeted at 10 s drain plus 30 s backup plus 5 s go-to-health, so under a normal cutover queued mutations still time out into 503. Bound the wait by the freeze's own budget, or release the queue when the freeze ends rather than on a timer. Also in this family: `index.ts:138` refuses page publication and page undo with a retriable 503 whenever any app mutation is in flight, with no queue; this is the repair surface and it should wait.

### 29. Storage admission on the hot path

**Comment.** `2979676` wired the per-mutation reservation admission to `storageHeadroom.check()`, which spawns `stat` or `df` and waits for it, inside boot's `seq` write transaction, under the app's 1.5 s channel timeout. Every message post is now one subprocess spawn serialised behind the reservation. Sample the volume on a timer into a `Ref` and admit against the last sample. Related: a storage-settings change or one failed measurement turns every write into a non-retriable 507 for up to a minute (`event-storage.ts:163`); re-measure inline on policy change and mark measurement failures retriable.

### 30. Recovery must leave a way in

**Comment.** `index.ts:154` still dies on conflicting recovery intents, and any recovery failure sets the phase to Failed, which refuses every write route including the two the human recovery page itself calls. Replace the die with a typed refusal, keep the lock and revert pair writable in the Failed phase, and let `afterResolve` clear an orphan `topic_page_moves` row so a stale intent cannot outlive a restart.

### 31. Smaller items from the pass

**Comment.** `pages-http.ts` gets the item 6 treatment (nested ternaries and a bodiless 503 remain). Enrollment enforces the lowercase host it documents (`enrollment.ts:78`, and the same class in `token-mint-schema.ts`). The README still documents six deleted routes. Drop the `reactions` and `agents` creates from the fresh-store rungs. `webhook_subscriptions` is created twice, by the app migration ladder and by `api.migrate`, with divergent DDL; delete the ladder file. The subscriptions error union declares two codes at two statuses, and `SubscriptionError` carries a `status` field nothing reads. `topics-http.ts` re-parses the raw URL instead of using its declared `:path` param and classifies a bad path as `query_invalid` on read and `input_invalid` on write. `sql-write.ts` should take its protected-table set from a registry extensions fill (`api.migrate(..., {protect:true})`) rather than hard-coding a core table. `extension-api.ts` should not type the kernel contract in terms of `ext/core`'s services. Event reads should not take the child channel gate. Every proxied request publishes an `http.request` event that wakes every idle long-poll; keep diagnostics off the publication sequence or let `changed` ignore diagnostic-only moves. `ctx.read` needs a bound. Board HTML needs the CSP `/p/**` has. Anonymous public-page reads answer a non-retriable 401 during recovery; answer a retriable 503. `extensions.md`'s worked example queries a table that does not exist and `standup.ts` imports a core internal. The subscriptions example bypasses `api.effects` for its deliveries and runs an empty durable transaction per delivery as a liveness check.

## Database stack, round two (2026-09-12)

Item 23's track, reviewed PR by PR at the heads below. Full report: `stack-review-round2.md`. PR #1 merged to master as `dd733fe`, the stack was recomposed on top of it, and it grew to five: #7 and #8 had never been reviewed before this round.

| PR | Head | Verdict | Findings | Comment |
| --- | --- | --- | --- | --- |
| #2 store descriptors | `1ef641e` | mergeable with changes | 13 | 5644305395 |
| #3 store identity | `f4f1dca` | needs changes | 11, one blocker | 5644334307 |
| #4 DbOps and backup provenance | `7d47607` | needs changes | 15, two major | 5644329084 |
| #7 migration histories | `aaf6396` | needs changes | 11, two major | 5644472625 |
| #8 portable SQL, Postgres and MySQL | `686e07c` | needs changes | 16, four major | 5644467131 |

Each PR got two Opus finders on orthogonal dimensions, each re-read by an Opus skeptic, plus a claims agent that installed, checked, built and tested in that PR's own worktree. 66 confirmed, 2 refuted.

**The owner-facing question this round raises.** The track's goal is that swapping the engine on deployment just works. At the stack tip that is further away than the PR bodies suggest, for one concrete reason: no remote engine is exercised by the default suite, and the dialect SQL is never executed against Postgres or MySQL anywhere. `dialect.test.ts` runs only its SQLite branch and string-matches the other two, and the real-server CI fixture touches the connection lease and the integer guard but none of the twelve rewritten query modules. Three defects already sit in that blind spot: the published-image CTE has no Postgres form that parses, the MySQL read-mark upsert references a column MySQL cannot resolve, and boot's public-path cascade silently matches nothing on MySQL. All three are invisible to every check in the repo. The cheap fix is to run the dialect tests inside the existing remote-session CI legs, where live Postgres and MySQL already exist.

## Decisions after the ownership audit (a834e3f, 2026-09-11)

Codex's `docs/boot-ownership-audit.md` narrowed four things the review had recorded the other way, and the owner gave Codex direction directly on the first. Recorded here so the ledger, the spec and the code agree. Check: `docs/pr-1/ownership-check-a834e3f.md`.

### 32. Events split: boot serves its own lifecycle events, the app serves application events

**Decided by the owner, 2026-09-11.** The log and `seq` stay in boot: one seq space, the fence, `POST /_boot/events/append`, `/_boot/seq/*`. What changes is the read surface. `GET /_boot/events` answers with boot's own events only (`generation.*`, `lock.*`, `fs.*`, `backup.*`, `db.restored`; `generation.failed` carries the redacted stderr tail). It needs no app and is the dead-app diagnostic surface. `GET /api/events` and `GET /api/stream` are app routes: the kernel reads the whole log over the localhost channel, and the app applies the type, topic, agent and instance filters and the `wait=`. Consequence, accepted: an application event wait runs in the child, so a swap ends it with `drained:true` exactly like `/api/messages`, and the client re-issues from the cursor. The "wait on `/api/events` instead, it hits the bootloader" advice leaves `/init` and §6.2. Spec: §5 examples, the §6 rows for `/_boot/events` and `/_boot/stream`, the §6.1 paragraph on how the app reads the log, §6.2, §7.1 invariant 2, the §7.7 flip bullet, §12 item 21. Codex implemented this in `2ee17ac`; the third pass checks it.

### 33. Anchored edits out; conditional raw writes in

**Decided 2026-09-11 on Codex's audit; owner not objecting.** `POST /_boot/fs/edit` (old_string/new_string anchors) is removed. `PUT /_boot/fs/<path>` takes the content token `GET` returned (`baseVersion`, `null` for a new file) and refuses `409 stale_base` when the bytes moved; the agent's own edit tool does the string replacement locally over the bytes it read. Boot keeps compare-and-set, locks, path checks, modes and atomic publication and stops being a text editor. Spec: the §6 row for `/_boot/fs/edit`, the §7.6 anchored-edit bullet. Codex implemented this in `ba5866b`.

### 34. No `GET /_boot/metrics`, no child trace aggregation in boot

**Decided 2026-09-11 on Codex's audit; owner not objecting.** Item 21 asked for the metrics route to be implemented; that is withdrawn. `/_boot/status` is boot's operational surface. Counters and Prometheus text are an extension if anyone wants them. Boot's `http.request` record is its own bounded view of each request it answered or forwarded (verified identity, request id, method, path, status, duration, redacted); it no longer parses the child's span annotations, and the app exports its own spans. `docs/tech.md` §8's one aggregated wide event becomes two records sharing a request id. Codex implemented this in `dd3c6e7`.

### 35. Retention: boot keeps the byte cap, the calendar leaves (proposed; implemented by Codex in `e38d60c` ahead of confirmation)

Item 21 says event retention is one of two policies boot enforces when the app is dead; SPEC §12 says retention rules belong to the app. The audit's split resolves it: boot keeps the physical protection (the 5% headroom refusal and the 10% event byte cap with protected-artifact reclamation) because a full store must not block auth or recovery, and the 7-day/30-day calendar pruning in `event-retention.ts` and its settings keys go. Nothing replaces them: agents carry `since=` cursors, and a log that only shrinks under byte pressure is simpler than a schedule in boot. If confirmed: §6.1's "pruned hourly by the bootloader" changes, §7.5 keeps the cap sentence, and item 21 loses "retention" from the enforce-when-dead pair.

### 36. Delete `legacy-topic-moves.ts` (proposed; reduced by Codex in `8cc783e` to a 7-line presence probe plus a refusal; see item 45)

Item 27 asked for the 228 lines of topic-move machinery to go. They went, and 282 new lines arrived in `legacy-topic-moves.ts`: startup-only recovery of old boot-owned topic-move tables, with a whole-tree hash walk and a page-subtree `fs.rename`, both of which item 21 removed from boot. There are no deployed stores, so there is no legacy data to recover. Recommendation: delete the file, and refuse to start on an old store version with a clear message. The ownership audit does not mention the file in either list. The third pass confirms it from three dimensions (A-2, B-3, and the claims agent's F4): the file runs on every recovery pass, not only first start, because `index.ts:130` and `:140` sit inside the recovery permit; and its blanket `Effect.mapError` to `topic_move_recovery_required` at `:61` and `:282` turns any transient SQL or filesystem error while reading two tables that never exist into a refused boot.

### Status at a834e3f, from the ownership check

25, 26 and 29 fixed. 31 is seventeen of eighteen. 27: all four sub-items fixed, size unmet (12,265 lines in 93 files; the scratchpad's 9,361 in 78 matches no counting rule). 28 still open: `supervisor.ts:269` releases the mutation gate only when the failure is a `ChildError`, so a health-probe `TimeoutError` leaves the gate frozen for the process lifetime; the queue-versus-freeze numbers are fixed. 30 partly: lock and revert reopen only if a re-run of recovery succeeds. The scratchpad now says the owner made ownership scope, not line count, the criterion; the ledger's rule is the six jobs, and the line count stays the way we measure it.

## Status after the third pass (2ee17ac, 2026-09-11)

Report: `third-pass-2ee17ac.md`. Five Opus finders, five Opus skeptics, one claims agent; 26 findings confirmed, none refuted; eight of them objected to changes the owner has since decided (items 32 to 34) and are marked superseded in the report. `bun run check` and `bun run build` pass. `bun run test` is **red at the pushed head**: 781 tests, 1 failed, 1 skipped. Boot is 12,265 lines in 93 files, up 59 since the second pass.

| item | status | what remains |
| --- | --- | --- |
| 25 mentions and over-marking | partly | Trailing punctuation fixed with tests. The leading side is untouched: `**@codex**`, `"@codex"`, `_@codex_`, `\|@codex\|` extract nothing (A-1). Over-marking has a root case: a query with neither `topic` nor `mentions` marks topic `''`, which `topics.ts:28` treats as an ancestor of every topic, so `GET /api/messages?q=deploy&limit=1` zeroes every unread count for that instance (skeptic, items-25-31). |
| 26 route collisions | fixed | `templatePattern` folds a terminal `/*` to `/:parameter`; the later extension fails alone; `extension_disabled` declared. |
| 27 finish the boot cut | partly | Preamble, `rahul` literal and Bun cache done. The 228 deleted lines came back as 282 in `legacy-topic-moves.ts` (item 36). Size 12,265. |
| 28 freeze gates | partly | Queue budget fixed (one 60 s budget over the 45 s frozen region). Page publication queues. But `75fa8f1` removed the finalizers `4147a1a` added: release now depends on `supervisor.restart`'s compensation, which fires only for a single-reason `ChildError` (`supervisor.ts:269`); `cutover.ts:325` returns frozen on `accepted_snapshot_missing`; `cutover.ts:352` still calls `finish(owner,false)` as a bare last statement; `database-backup.ts` freezes at `:64` with no finalizer. |
| 29 storage admission | fixed | Out-of-band 1 s sampler with a 5 s staleness cliff; fails closed. |
| 30 way in after failed recovery | partly | The die is a typed `recovery_intents_conflict`; `GET /_boot/fs` and `GET /_boot/lock` read in the Failed phase; anonymous pages 503. But `POST /_boot/lock` and `POST /_boot/revert` become writable only after `retryRecovery` succeeds (`edit-http.ts:52-62`), and a deterministic recovery failure fails it every time. |
| 31 smaller items | mostly fixed | 16 of 18. `topics-http.ts:30-40` still re-parses the raw URL for the wildcard route; `/api/events` and `/api/stream` waiters still wake on every diagnostic fence move. |
| 21 bootloader | partly | Named moves hold; `POST /_boot/restart`, `revert {withDb}`, headroom refusal and the CI table guard are real. Metrics withdrawn (item 34). Size unmet. |
| 32 to 34 | decided | Implemented in `2ee17ac`, `ba5866b`, `dd3c6e7`; follow-through in item 40. |

## New items from the third pass

### 37. Mentions, third time: the leading delimiter, and the root over-mark

**Comment.** `message-mentions.ts:6` still requires the mention to follow start-of-string, whitespace, `(` or `[`, so a bolded, quoted, italic or table-cell mention delivers to nobody, on a board that renders markdown. Replace the prefix alternation with a lookbehind that excludes only word characters and `@`, and add the four cases to the test. Second, `api.ts:65-68` enables marking with topic `''` for any query that has neither `topic` nor `mentions`, and `read-marks.ts:20` writes that row; `topics.ts:28` reads `''` as covering every topic. A search or a bare `?limit=` must not mark anything: mark only when the query has a topic, and never at `''`.

### 38. The freeze gates, fourth time: unconditional release, and a supervisor that re-enters recovery

**Comment.** Restore the finalizers `4147a1a` added and `75fa8f1` removed, or make the lifecycle release unconditional: every path that freezes (`cutover.ts:208`, `:320`; `database-backup.ts:64`) releases in `Effect.ensuring`, guarded only by proven closure, whatever the failure type. `supervisor.ts:269` must not decide on `ChildError` alone: a `TimeoutError` from the 5 s health probe or a `SqlError` from `generations.healthy` currently leaves the gate frozen with no child. The edit lock has the same shape: `cutover.ts:352` runs `sources.recover`, `sources.discard`, `finish(owner,false)` as bare statements, so a failed journal replay leaves `cutover_in_flight` set. And `supervisor.run` (`:326-331`) idles forever when `current` is null; it should re-enter `recover` under the existing per-generation cap, so one failed restart on a rollback path is not a permanent 503 until a human signs a restart.

### 39. The way in, third time: lock and revert must not wait for recovery to succeed

**Comment.** In the Failed phase a human `POST /_boot/lock` and `POST /_boot/revert` must be admitted whether or not `retryRecovery` succeeds; today `writable` is set only after it returns (`edit-http.ts:52-62`), and a deterministic failure (a legacy refusal, a failing `coordinator.recover`) fails it on every call, including after `POST /_boot/restart`. Admit the write, run recovery afterwards, and report the recovery failure in the response body.

### 40. Item 32 follow-through: the split as decided, in both processes

**Comment.** (a) `GET /_boot/events` is scope `read` and takes `wait=`: `event-http.ts:225` gates it on human-or-`fs`, and the diagnostics branch at `:271-289` has no wait, so an agent cannot wait for `lock.released` while the app is down, which is the one thing the boot surface is for. (b) The app's `/api/events` must not loop on the raw fence and re-query boot over HTTP per wake (`events-http.ts:36-41`, `stream-http.ts:42-47`); boot's channel query already long-polls on the commit signal, so pass `wait=` through and delete the app-side loop. (c) Boot trusts a child-supplied `request_actor` for `http.request` visibility (`public-event-http.ts:33`, `:75-79`); clamp in boot from the identity headers it forwarded, so an extension overriding `/api/events` cannot read every agent's diagnostics. (d) `init.md:33` and `recipes.md:48` still say `/api/events` is boot-served and survives swaps. (e) `kernel-recovery.test.ts:106` fails at head because the seed child fixture has no `/api/events`; fix the fixture. (f) The narrowing added 74 lines to boot; the retained `public-event-http.ts` engine is the child transport and stays, but nothing else should duplicate it.

### 41. An extension can protect a core table it does not own, permanently

**Comment.** `extension-migrations.ts:27` derives the protected table from the statement text of `api.migrate(name, sql, {protect:true})` without checking that the migration created it, and nothing ever deletes from `protected_sql_tables`. `CREATE TABLE IF NOT EXISTS messages(...)` in any extension permanently closes the `fs`-scope `POST /api/sql` write path for `messages`. Register only tables the migration created in the same transaction, and drop the registration when the extension's migrations are removed.

### 42. The health probe must not encode core's product contract

**Comment.** `kernel/health.ts:66-92` posts to `/api/messages`, reads `/api/messages?topic=` and `/api/topics/<path>` and decodes core's response shapes, against the assembled dispatcher. Item 2 allows an extension to override those routes; doing so now fails the health gate and the reload. Probe what the kernel owns: a `kv` round-trip through `ctx.mutate` and `ctx.read`, plus a rollback assertion.

### 43. Smaller items from the third pass

**Comment.** `sql-http.ts:37-42` spawns the reader subprocess before the read-scope check and the check after it is dead code. `decode-rows.ts` exists but 45 raw decode sites remain in 19 boot modules, and the directory-sync helper is copied six times. `topics-http.ts:30-40` re-parses the raw URL for the wildcard route. `read-marks.ts:8-13` exports a dead `effectiveCursor` that still branches on the removed `~inbox`. `subscriptions/response.ts:57` has two identical arms. Two divergent digest examples exist (`examples/extensions/digest.ts` and `packages/server/examples/extensions/digest.ts`); keep one. `public-paths.ts:29-42` refuses child activation when the app marks more than 4,096 pages public or the list exceeds 512 KiB; that is a boot number gating an app policy, so document it in the spec or raise it to a store limit. `scripts/check-invariants.ts:81` guards only four table names; derive the list from the server's schema. The storage sampler answers `storage_measurement_failed` for the first two seconds after boot.

## Status after the fourth pass (efa6de5, 2026-09-11)

Report: `fourth-pass-efa6de5.md`. Four Opus finders, four skeptics, one claims agent; 23 findings confirmed, 3 refuted. **Check, build and the full suite pass at the pushed head** (775 tests, 1 opt-in skipped). Boot is 12,157 lines in 92 files, down 108: the first net decrease.

| item | status | what remains |
| --- | --- | --- |
| 35 retention | implemented, awaiting confirmation | Calendar pruning and its settings keys gone; headroom refusal and byte cap intact; old stores start. Two consequences to decide with it: eviction is now oldest-first across types, so `http.request` volume evicts lifecycle history and quiet boards keep request rows forever (prefer evicting `http.request` first); and `source-revert.ts:139` still runs an hourly 30-day calendar prune for revert receipts. |
| 36 legacy topic moves | partly | 282 lines became a 7-line probe plus a fail-closed refusal; the hash walk, rename and app-store open are gone. But boot migrates the store to schema 16 **before** the probe runs, so the refusal's own hint ("use the previous image") is impossible, and the probe also switches off the event byte-cap pruner for the life of the process (item 45). |
| 37 mentions | fixed, residual | The four named cases deliver and root marking is gone. The suffix still enumerates `\p{P}`, so `~~@codex~~`, `` `@codex` `` and `<@codex>` deliver to nobody, and the widened prefix now matches `/@codex` inside URLs (item 44). `ctx.topics.markRead("", seq)` from an extension still writes the root row (item 44). |
| 38 freeze gates | fixed | The `ChildError` predicate is gone; health timeout is a typed `ChildError`; `supervisor.run` wakes on a queue instead of idling; the bare `finish` became a retained cleanup retried on the next authorized edit. `accepted_snapshot_missing` and the backup path release through `requestRecovery` rather than a finalizer; `database-restore.ts:391` shows the `Effect.ensuring` shape they should share. |
| 39 the way in | partly | `POST`/`DELETE /_boot/lock` are admitted in the Failed phase and report recovery in the body. `POST /_boot/revert` still requires `retryRecovery` to succeed (`edit-http.ts:58-63`). The new `repairLock` guard refuses `lock_recovery_conflict` for a stranded pages publication, whose batch has no lock owner, so the one way in can itself be refused (item 46). |
| 40 events follow-through | fixed, one spec question | `/_boot/events` takes scope `read` and `wait=`; the app forwards `wait=` to the channel; docs and the fixture fixed. Boot now omits `http.request` rows from the child channel entirely rather than clamping them, so `/api/events` returns none while SPEC §6 promises own-agent rows (item 47). |
| 41 protected tables | partly | Adoption of an existing table is refused. Registration is permanent, the word-match guard blocks any statement mentioning the name, and `api.migrate` itself never consults the set, so an extension can `DELETE FROM protected_sql_tables` while `/api/sql` cannot (item 48). |
| 42 health probe | fixed, overshot | The probe is a kernel `kv` round-trip with rollback and a core override passes. It no longer dispatches any HTTP route, so a reload that breaks every route passes health and is stamped `good` (item 49). SPEC §7 still describes the old self-test. |
| 43 smaller | mostly | Scope-before-spawn, `effectiveCursor`, one digest example, the derived CI table list, the `public_paths` cap and the first-sample wait are done. Still open: the sync helper copied five times, `decode-rows` at 40 of 56 sites, `topics-http.ts` raw URL parse, `response.ts:57` identical arms. |

## New items from the fourth pass

### 44. Mentions, fourth time: negative classes on both sides, and no root mark from extensions

**Comment.** Replace the trailing `(?=$|[\s\p{P}|])` with `(?![\p{L}\p{N}\p{M}])` and add `/` and `:` to the lookbehind exclusion, so strikethrough, inline code and angle brackets deliver and a pasted `https://x/@codex/repo` does not. Add those cases to the test. `capabilities.ts:110` must reject `path === ""` with `input_invalid` so no extension can write the row that zeroes every unread count. Update `conversation.ts:34` and the three `/api/topics` descriptions, which still promise root marking.

### 45. Item 36, the shape: check before migrating, and never disable the byte cap

**Comment.** Run the legacy-table probe before `initializeBootSchema` and refuse there, so a store that carries `topic_moves` is not rewritten to schema 16 first (today the hint "use the previous compatible image" cannot be followed). Better, since no deployed store has these tables: drop the compatibility path and refuse to start on a pre-cut `user_version` with a clear message. Either way `storage.run` must fork unconditionally (`index.ts:84-87`); a refused store is exactly the one boot keeps appending auth and request events to with no pruner.

### 46. The way in, fourth time: revert too, and no self-refusal

**Comment.** Give `POST /_boot/revert` the `repairLock` shape: admit the human, run `retryRecovery` afterwards, report the failure in the body. Then fix the guard `a25530a` added: `edit-lock.ts:186-213` refuses `lock_recovery_conflict` when a `source_batches` row in `publishing` names no lock, which is every stranded pages publication, so a human cannot take the lock to repair the one thing that needs repairing. An ownerless batch must not count as a competing owner.

### 47. Where `http.request` rows live (owner to confirm)

**Comment.** Codex removed request records from the child channel entirely, so `GET /api/events` never returns one, while SPEC §6 says an agent sees its own. Proposed resolution, consistent with item 32: `http.request` is a boot event and appears only on `GET /_boot/events`, clamped in boot to the caller's own agent unless human; `/api/events` carries application events only. If confirmed, the §6 rows change, `requestActor` leaves `EventQuery`, and the evlog sink points at `/_boot/events`.

### 48. Protected tables, second half

**Comment.** Record `(name, extension, migration)` and drop rows whose migration no longer exists during loader reconciliation. Scope the refusal to the tables a statement targets, using the tokenizer `check-invariants.ts` already has, not a word match over the whole text. `api.migrate` must consult the same set: today it admits `DROP` and `DELETE` against anything, including `protected_sql_tables` itself.

### 49. Readiness must still dispatch a route

**Comment.** Item 42 asked the probe to stop encoding core's product contract, not to stop exercising the router. Keep the `kv` probe and add one dispatch through `extensions.dispatch` of a kernel-reserved route (`/_kernel/health`) so router assembly and request-time dispatch are both proven before a generation is promoted; today a reload that breaks every route is activated and stamped `good`. Then record the readiness change in SPEC §7.2 (the self-test paragraphs at lines 509 to 518 and the "self-test" wording at 579) as a dated bullet.

### 50. Smaller items from the fourth pass

**Comment.** A failed accepted-cutover metadata cleanup leaves the lock pinned and every hint steers the agent away from the request that clears it; retry it from the reload route or surface it in `/_boot/status`. `stream-http.ts:41` lost its empty-page guard, so a boot read failure becomes a zero-delay loop; sleep or end the stream on an empty unchanged page. `public-paths.ts:39` runs one `INSERT` per path inside the append transaction under the channel gate, bounded only by the 1 MiB body; batch it. `init.md:37` and boot's `GET /_boot` help still teach a tokenless `PUT`, which is now `400 precondition_required`. The lock-repair response shape (`lock_committed`, `recovery`) is undocumented and answers 200 on a failed recovery. `retryCleanup` runs its authorize effect twice. `examples/extensions/README.md:5` names a file that does not exist and the surviving digest example's import does not resolve when copied into `app/ext/`. `kernel/README.md:7` still forbids the probe design item 42 introduced. The recovery ladder has no total budget (5 s × 3 attempts × generations). Codex's three ledgers still describe 35 and 36 as unimplemented.

## Live-board onboarding review (2026-09-11, decided 2026-09-13)

Source: `live-board-review-2026-09-11.md`. A newly enrolled agent fetched `/init` with no prior knowledge, enrolled, and exercised every live route with `read`, `write` and `fs`. Thirteen findings, ordered by what they cost the next agent. The mechanics held up: the error envelope, conditional writes, idempotency, refresh rotation, topic semantics, SSE resumption and `/.well-known/agent.json` all worked first try. The damage is concentrated in the first ten minutes, and four findings are defects in the onboarding path itself.

### 51. The on-ramp tells the truth (findings 3, 6, 11, 12)

**Decided 2026-09-13.** None of the four pages `/init` links is usable before enrolling: `recipes.md` opens with "use these recipes after enrolling", `editing.md` needs `fs` scope, `extensions.md` is about editing a running board, `stream.md` uses the human's cookie. So do not publish them. Instead `/init` states that its links need a token, and a new post-auth `/quickstart` links onward to them. Also: `/init`'s agent-home example must lead with the combined form `mentions=@name,@name/label,@here`, because `mentions=@claude` does not match `@claude/mac` and an agent copying the current example silently never receives anything addressed to its instance. `/init`'s Live routes block is assembled from the app spec only, so it omits `/api/lock`, `/api/fs/*` and `/api/reload`, the very routes the prose above it tells you to call: include the boot aliases or label the block as extension routes. And the bounds belong in `recipes.md` as a short table (`limit` caps at 200, `wait` at 60) rather than only inside the `/api` document. **Measured 2026-09-13, and it changes the fix:** `/api` is 214,680 bytes of which 204,674, or 95.3%, is `responses`, because a 48-member error union is inlined into all eleven operations instead of referenced once. Hoisting that union behind a `$ref` is the real fix for the document's size, and it is worth doing on its own merits; the bounds table and a hint that names the offending parameter are still worth having, but they are not why `/api` is large. Note also that `recipes.md` is already correct on the mention and mark points below: the stale surface throughout this item is `init.md`, at lines 33 and 70.

### 52. Mentions, fifth time: the URL false positive and the backtick drop (finding 2)

Confirmed live from the board, and it is the same defect as item 44. A slash is not excluded by the leading lookbehind, so any link ending `/@name` pages that agent, and Mastodon handles, GitHub raw URLs and profile links all have that shape. A backtick is Unicode category Sk rather than P, so it fails the trailing test and an inline-code mention is dropped, which is the one place an author deliberately writes a name without meaning to page anyone. Treat a preceding `/` as part of a URL and accept a backtick the way `**` and `_` already are. Implement this inside item 44 rather than separately, and close item 44's other half at the same time: `ext/core/capabilities.ts:110` still admits an empty path, so an extension calling `markRead("")` writes the root row that zeroes every unread count for that instance.

### 53. Boot bookkeeping in the app feed (finding 4)

41% of events on an idle board are `seq.reserved`, carrying `actor: "boot"`, `generation: 0` and transaction and attempt hashes. Nothing an app consumer can act on, and every agent following the documented listen recipe pays tokens for them. Item 32 put `/api/events` on the app side and left boot serving its own lifecycle feed, so these should not be in the app feed at all. Filter them the way `http.request` is already filtered.

### 54. The published OpenAPI declares no authentication (finding 5)

Every operation in `GET /api` carries `"security": []`, including `POST /api/sql` and `POST /api/messages`, while both reject an unauthenticated call at runtime. A client generated from that document ships with no auth and fails on first contact. The boot manifest gets this right: `/.well-known/agent.json` declares its schemes, per-route `security` and an `x-comms-scopes` extension. Carry the same declarations on the app document.

### 55. Errors name the field (finding 7)

**Decided 2026-09-13: keep one code, name the field.** A bad topic path, an empty body, an unknown field and two mutually exclusive shapes in one `PUT` all return `input_invalid` with an identical hint and no field name, so each one costs a guess and a retry. Add the offending field, and the bound where there is one, to the error body, and make the hint specific ("Topic paths are lowercase", "Body cannot be empty"). Additive: the `Schema.Literals` code union from item 6 does not change.

### 56. `archived_by` is not an actor (finding 8)

It holds the ancestor whose archival propagated down, and the name reads as an identity sitting beside `agent` and `instance` fields that really are identities. Rename to `archived_root`. There are no deployments, so the rename is free. Alongside it, archiving a parent does empty the subtopic list on a plain read (`topics.ts:30`). **Corrected 2026-09-13:** the review asks for `archived=1` in the `topic_archived` hint, but that is a write error and the read route's own description already says archived children require `archived=1`, so the discoverability gap is smaller than stated. Leave the hint alone.

### 57. Self-echo is inconsistent across the three listen surfaces (finding 9)

**Narrower than the review states, corrected 2026-09-13.** Two of the three surfaces agree: `message-wait` and `events-http.ts:29` both set `excludeMessageInstance` while waiting. Only `/api/stream` echoes the caller's own writes, and none of the three documents the rule. So this is one line in the stream route plus a sentence in the recipes, not a three-way reconciliation. An agent that starts on long-poll and switches to SSE for latency still inherits a feedback loop on its own writes, which is the cost that matters.

### 58. Webhooks stay unsigned (finding 10)

**Decided 2026-09-13: no signing, document the limitation.** Deliveries carry `x-comms-delivery-id` as an idempotency key and no signature, and any `write`-scoped agent can point a subscription anywhere including at another service on localhost. The stated trust boundary is mistakes rather than adversaries, so this is a misconfiguration risk and stays one. Record it plainly in the subscriptions guide rather than adding a secret and an HMAC.

### 59. Page writes report a source error (finding 13)

Publishing a page without a precondition returns `precondition_required` with the message "Source edit refused", and a stale one returns `stale_base` with the same. The docs work to keep pages and source apart, since pages publish immediately and need no lock and no reload, and the error text undoes that. Give the page path its own message. Alongside it, raw page reads come back as `application/octet-stream` for `.md`.

### 60. Unread marking on a latest-N read (finding 1)

**Decided 2026-09-13, smallest fix.** The documented first read is `newest=1`, which returns the top slice and skips everything earlier, while the mark advances to the highest sequence returned: observed, seven unread became zero from a read that returned one message. **Corrected 2026-09-13:** `recipes.md` already tells background reads to add `mark=0`; the live trap is `init.md:33`, which shows `topic=project&recursive=1&newest=1&limit=50` with no `mark=0`. The code fix below still stands, because `/init` is the page every agent reads first. The unread badge is human-UI only (`packages/ui/src/app.tsx:126` and `:273`), so this is low stakes and does not warrant a redesign. A `newest=1` read marks nothing; every other read is unchanged. Noted for later: if the badge is not worth keeping, removing the unread concept entirely also removes this, the root-mark case in item 44 and the over-marking class, which is a real simplification rather than a fix.

## Found while merging the stack (2026-09-13)

Two things surfaced by the pre-merge pass that are now on master, recorded so they are not lost in the merge noise. Neither blocked a merge.

### 61. Source-revert receipts grow without bound

`23db345` ("Retain source revert outcomes without calendar expiry", merged in #2) removes the whole prune and retain loop from `packages/boot/src/source-revert.ts`, and `index.ts` now calls only `reverts.recover`. The intent is right and favours durability: an idempotency receipt should not expire by age while a replay can still arrive. The consequence is that `source-revert-result:` rows in `settings` accumulate one per revert request forever, and `source-revert.ts:98` reads all of them with `SELECT key,value FROM settings WHERE key LIKE 'source-revert-result:%'` on every recovery. Human-initiated, so growth is slow, but the scan is on the recovery path. Bound it by count or keyspace rather than by calendar, which is the same conclusion item 35 reached for events.

### 62. The board UI aborts a revert on the new 503

`3ab1962` made the lock route answer 503 while carrying `lock_committed: true` in the body, which is correct and which boot's own recovery page already tolerates: it catches the error, re-reads the lock and proceeds. The browser client does not. `packages/ui/src/recovery-api.ts:28-34` catches `BoardError` only when `status === 423`, so the 503 falls through and aborts the revert. Leave the board open, let recovery fail so the surface becomes non-writable, click undo: the lock commits server-side, the user sees a failure, and the second click succeeds because the lock is now found and the POST is skipped. One wasted click and self-healing, so it is minor, but the fix is adding 503 beside 423 in that `catchTag`.

### 63. The descendant portability bug did not leave, it was inlined (now a PR #8 blocker)

**Corrected 2026-09-13.** My PR #4 and PR #8 reviews both said `packages/storage/src/descendant.ts` still existed and was still imported by `boot/src/public-paths.ts`, carrying a SQLite-only `||` concatenation that on MySQL is a logical OR and therefore matches nothing. PR #4's `5d14a34` was titled as addressing it. What it actually did was delete the storage module, its package export, its test and its fixture, and inline the identical SQLite-only SQL at both call sites. A grep for `isDescendant` across `packages/` now returns nothing, and `public-paths.ts` carries the unportable form in three places: `:53` and `:60` build `substr(path,1,length(x)+1)=x||'/'`, and `:59` builds a replacement path with `${to}||substr(...)`.

So the defect is unchanged and is now duplicated rather than shared. The consequence is the same and still silent: the moment boot runs on MySQL, a topic deletion or a topic move leaves every descendant public path published, because the predicate evaluates to 0 or 1 and matches no row. Postgres is unaffected, which is what makes it easy to miss.

Codex's own follow-up assigns the dialect-aware helper to PR #8 and says the portability coverage must be retained when that layer is composed. That is the right home, so this is tracked as a **PR #8 blocker**, not a PR #4 one, and #4 merged with it outstanding on that basis.

### 64. Size reduction pass, after the database stack merges (decided 2026-09-13)

**Decided by the owner.** Once #9, #10 and #12 are in, do a deep audit of bloat and a substantial size reduction. Recording the measurements that prompted it so the audit starts from facts rather than impressions.

Master at `1156548`, production source only, tests excluded: boot 13,536 lines in 101 files, server 7,315 in 92, ui 3,340 in 39, protocol 761 in 20, storage 810 in 9. Total about 25,800 across 261 files, with 40,544 further lines of tests. PRs #9 and #10 add roughly 19,000 more production lines, which would put the tree past 45,000 and boot alone near 24,000.

The sharpest single fact: SPEC §7.1 line 401 budgets the immutable core at "about 6,000 to 7,000 lines, of which roughly 2,300 are durability machinery, with five runtime dependencies; a real bootloader's scope and nothing else". Boot is 13,536, about double, and `boot-audit.md` already found 7,250 achievable and named the cuts. Boot has grown through every review round rather than shrinking.

Four causes worth carrying into the audit, because they suggest where to look.

**Duplicate answers to one question.** Much of the machinery exists to establish *is the previous owner really dead*, and there are now several parallel mechanisms for it: keeper receipts, the kernel boot-id check, process-group closure proof, the owner inventory, the copy keeper's own receipt, the writer epoch CAS, the publication fence, intent journals and the adoption record. Each was justified on its own; nobody has asked whether three of them could answer for all.

**Review-driven accretion, substantially my fault.** Sixty-six findings across the stack, and almost every one was closed by adding a mechanism rather than removing a case. Asking for typed errors produced a code-to-status-to-hint record in every module; asking for a way back in produced a five-condition repair admission; asking for closure proof produced a keeper plus a receipt plus a fallback. A reviewer who only says "this case is unhandled" produces a codebase where every case has its own handler.

**File-per-concept.** #10 alone adds `transfer-sentinel.ts`, `transfer-target.ts`, `transfer-file-digest.ts`, `transfer-app-authority.ts`, `transfer-dump-authority.ts` and sixteen more.

**The dominant line item is the optional one.** Engine portability is roughly 20,000 lines once #9 and #10 land, for a board that runs on SQLite, on one machine, for one human and their agents. The product itself is not big: eleven core operations, thirty-five boot routes, and the whole board in 11,400 lines. That part is about the right size.

**Sequencing note, raised once and not pressed.** The largest line item is the part still unmerged, and deleting unmerged code is free while deleting merged code is a migration with a schema ladder attached. The owner's call is to merge first and cut after; this records that the cheaper moment was before.

## Moot after the deletions

Findings that no longer need a comment because items 3 and 4 remove what they were about.

- SRV-7 (server conformance), `/api/inbox` scans the whole message table in JS and re-scans every 100 ms: the route is gone; the mention filter lands in SQL on `/api/messages`.
- SRV-4 (server quality), the UI fetches reactions per message, ~100 requests per topic view: reactions are gone.
- The batch read-mark gap and `POST /api/read` accepting `read` scope (API report §B): agents no longer post marks.
- The `cursor`-never-advances cost on an idle inbox long-poll (API report §B): no inbox route; item 8 makes empty waits cheap on `/api/messages`.
- The `/api/ctx` token-budget and priority numbers needing a cutover to change (API report §C): the digest is an example extension.
- SZ4's fourth idempotency table for reactions: folded by items 3 and 9.

## Refuted, not to post

- F1, lost keeper receipt plus pinned cutover is unrecoverable in-band: the spec mandates failing closed there. Worth a human-only escape hatch, but not a defect.
- F4 and SRV-3, `/_boot/agents` as a third channel operation: documented deliberate deviation in both package READMEs.
- DB-2, DB-3, DB-5 to DB-9: accurate readings that describe what breaks on a backend that does not exist. They are the inventory for item 19, not defects in this PR.
- SRV-12, missing move, sql writes and system view: documented deferrals.
- SRV-7 (server quality), no UI tests including for the markdown sanitiser: the owner does not want UI tests. Not posting.

## Draft of the top-level review comment

To be assembled from the confirmed items once the proposed ones have a call. Working text:

> Serious, careful work on the hardest parts of the spec: the keeper, the edit lock, the publication journal, the epoch fence and the credential handling are right and should stay. Not mergeable as the foundation yet for three structural reasons: the immutable half is half the tree and the extension boundary cannot carry the product; the declared HttpApi schemas never run and errors are flattened so agents cannot tell a bad edit from an outage; and both stores are welded to SQLite files with no seam. Nine design decisions from the review are confirmed, and every remaining major defect is to be fixed: read marks are automatic, extension routes are top level, no reactions, no inbox or digest routes, the declared HttpApi is the parser, errors are typed with defects never retriable, extensions can do anything except break the bootloader, the long-poll is fixed to always return its envelope, and the durable write protocol lives in one combinator. The ranked list below is the order to work in.
