# PR #1 review: "Build comms core with authenticated conversations and recoverable runtime"

Reviewed at head `b9d6f28` on `codex/build-comms-core` (the branch received two more commits, `4246e30` and `4885295`, while the review ran; line numbers below are against `b9d6f28`). Reviewed against `SPEC.md`, `docs/tech.md` and `AGENTS.md`, and against pi (`repos/pi-mono`) as the quality baseline.

Sub-reports in this folder, each self-contained:

| File | What it covers |
| --- | --- |
| [`adversarial-findings.md`](adversarial-findings.md) | 76 findings from seven reviewers (spec conformance for boot and server, code quality for boot and server/UI, data layer, size versus pi, trust boundary), each re-verified by a skeptic. 9 refuted, the rest confirmed or downgraded. |
| [`effect-idioms-and-abstraction.md`](effect-idioms-and-abstraction.md) | How idiomatic the Effect is, scored per area, and whether the code is over-abstracted, with pi as the baseline. |
| [`api-design-for-agents.md`](api-design-for-agents.md) | The API as a consuming agent sees it: golden path from `/init` with curl, route inventory classified primitive/convenience/policy, and a proposed minimal core. |
| [`database-interoperability.md`](database-interoperability.md) | What it takes to run both stores on one pluggable engine (SQLite, Postgres, MySQL), with the file-shaped guarantees mapped to engine-neutral forms and a proposed spec decision. |
| [`validation-run.md`](validation-run.md) | `bun run check` and `bun run test` actually run against the tree, with the flaky test diagnosed. |
| [`pr-comments.md`](pr-comments.md) | The confirmed and proposed comments that become the final PR review. Decisions are made here first, then mirrored into the spec. |
| [`boot-audit.md`](boot-audit.md) | File-by-file audit of the bootloader against "only what a bootloader does": verdicts, two cut levels, dependencies, routes, and the order to do it in. |

## Verdict

The PR is a serious, careful implementation of the hardest parts of the spec, and it is not mergeable as the foundation yet. Three things decide that:

1. **The immutable half is too big and the hot half is too thin.** The bootloader is 7.2k lines in 61 files against a spec that budgets it at "a few hundred lines, two deps". It is 50% of the source tree, and it is exactly the half an agent cannot repair by editing. Meanwhile `app/ext/` holds one 29-line read-only demo, and every product route the spec assigns to `ext/core.ts` is compiled into the kernel. The extension boundary cannot carry a schema or a sequenced write, so the spec's own named extensions cannot be written against it.
2. **The typed boundaries are decorative.** All nineteen HttpApi endpoints declare payload, query and success schemas and then use raw handling, so none of those schemas run. Bodies are read by a hand-pasted block in ten files. Every server error is flattened to one constant message and one of two hints, and an unclassified defect in edited code is reported as a retriable 503, which sends agents into retry loops instead of at the edit they just made. This is the finding you flagged, and it is the cross-cutting one: it makes the API contract lie, the OpenAPI document diverge from the parser, and the "recover from a bad edit" loop slower.
3. **Portability and the recovery guarantees are entangled with SQLite files.** Nothing reads `DATABASE_URL`. The app schema is a `PRAGMA user_version` ladder with an FTS5 virtual table; rehearsal, backup and restore are `VACUUM INTO` and file renames. Both stores are SQLite-only, and the bootloader's guarantees are the harder half to port.

Against that: the credential machinery, the child-process keeper, the edit lock, the source publication journal, and the writer-epoch fence are genuinely well built and well commented. The security reviewer could not break enrollment, refresh replay, path containment, the read-only SQL sandbox or the board's markdown renderer. Resource lifetimes are provably scoped and there is no module-level mutable state anywhere. Those are the parts to keep.

## Your questions

### How much bigger than pi is it, excluding tests?

It is five times smaller, not bigger. Counted with `wc -l` on non-test TypeScript:

| Tree | Lines | Files |
| --- | --- | --- |
| comms `packages/boot/src` | 7,239 | 61 |
| comms `packages/server/src` | 4,423 | 48 |
| comms `packages/ui/src` | 2,528 (+918 CSS) | 21 |
| comms total | 14,339 | 134 |
| pi `coding-agent/src` | 70,052 | 258 |
| pi `coding-agent/src/core` | 29,802 | 84 |

Tests are a separate story: 15,226 lines in 132 files, larger than the source tree, with boot's tests at 8.3k against its 7.2k of source.

Feature by feature, comms is smaller everywhere the two overlap: extension loading 793 lines against pi's 4,130; dependency preparation 485 against 4,933; UI 2.5k against pi's 38k of TUI. The three places comms is larger are the ones the spec demands and pi has no equivalent for: hot reload with durable cutover (2,670 lines, pi reloads in-process in about 150), passkey auth with refresh receipts (2,265, pi has none), and the durable event log with SSE (942, pi's event bus is 33 lines in memory).

So why does it feel bigger? Three reasons, all real:

- **The immutable-to-hot ratio is inverted from pi.** pi is one immutable binary hosting 26-line extensions. comms is 7.2k immutable lines hosting a 4.4k kernel hosting a 29-line extension. Half the code is the part you cannot fix by editing.
- **Concepts per feature.** Adding "pin a message" end to end touches eight existing files and three new ones across six layers: the version ladder, the published-image projection, a new operations file with the mutation protocol copied in, the service record, a new HTTP file, two edits in the conversation group, a UI client and a component. In pi the same class of change is one new file.
- **Three mechanisms are paid for twice.** The durable mutation protocol (reserve, write, outbox, re-reserve or abort) is hand-copied into seven kernel files while `operational-events.ts` already is the generic combinator. HttpApi is declared for nineteen endpoints and then bypassed by all nineteen. The UI re-declares server schemas in seven hand-rolled clients while `HttpApiClient` ships unused in the pinned Effect.

Could it be materially smaller? Yes, by roughly 1,000 lines and 15 files in the hot half without touching a guarantee (one `mutate()` combinator, one `jsonBody()` helper, one idempotency table instead of four, fold the six boot `*-schema.ts` files back into their owners), and by another 600 to 900 in boot by moving the parts that are not spec-mandated immutable (public-page topic semantics, the content-addressed artifact cache, account listings, the backup drill) into the app or dropping them. The floor for boot without moving responsibility is about 6,400 lines. That is still twenty times the spec's own estimate, so the spec line is what should change, and the decision about which of boot's eleven concepts must be immutable should be written down with the real number.

### Why so much in the bootloader?

Categorised by the boot code-quality reviewer with line counts per file:

| Category | Lines | What |
| --- | --- | --- |
| Required immutable by the spec | ~5,800 | auth, enrollment, tokens, passkeys 2,237; edit lock and edit routes 686; source publication journal 718; snapshots, cutover, generations 612; supervision, keeper, traffic 574; events, seq, fence, retention 740; proxy, wiring, schema 526; backups 332 |
| Could live in the hot app | ~590 | `public-pages.ts` owns the app's topic semantics (187); the content-addressed install and build artifact store inside `generation-preparation.ts` (270 of 485); the agent roster and account listings (139) |
| Optional or phase-deferred | ~150 | the weekly backup drill (88) which rehearses a restore route that returns 501; the kernel boot-id branch the spec explicitly defers |
| Boilerplate and duplication | ~700 | seven `*-http.ts` modules repeating a 13-line routing preamble; three status/hint tables as nested ternaries (~105 lines that should be ~35); four copies each of `hash`, `random`, `refuse`; seven copies of the stderr redaction regex; four copies of the child IPC schema across the process boundary; the commit-time authority check pasted verbatim into two files; eighteen inline row-decode wrappers |

The honest first reason is that the spec's estimate was for phase 0a only, and boot now contains phases 0b (rehearsal, freeze, backups, restore fencing) and 2 (enrollment, passkeys, refresh grace, mint, revoke). Those two phases alone are 2,600 lines. The second reason is the 10% mechanical duplication above. The third is that six `*-schema.ts` files exist to break import cycles through `auth.ts`, and fail to: the cycles are still there. The largest single readability gain in the package is collapsing `index.ts`'s three nested `Effect.provide` tiers and four null-initialised `Ref`s into one layer graph.

The one word that should change before anything else: `admit` means three unrelated things (`supervisor.admit` records an attempt, `traffic.admit` waits on the freeze gate, `edit-lock.admit` runs an action in a transaction with expiry cleanup). An agent that greps for it finds three subsystems.

### Hardcoded SQL: what happens on Postgres, and why not drizzle?

**Nothing happens.** `DATABASE_URL` and `BOOT_DATABASE_URL` are read by zero lines of code. You set the variable, it is ignored, and you keep running on SQLite files. `docs/deployment.md` admits this; `SPEC.md` still promises three backends.

If you wired `@effect/sql-pg` in tomorrow, measured over ~352 statement sites:

- **Hard failures**: 19 `PRAGMA` statements including both schema-version ladders, an FTS5 virtual table with three rowid triggers, 24 `json_extract` calls (19 of them in the boot event log, which stores every event as one JSON text column instead of the indexed columns SPEC §3 specifies), `json_each` over arrays, `VACUUM INTO`, `INSERT OR REPLACE`, `AUTOINCREMENT`, `sqlite_master`, an `IS NOT $param` null-safe compare, thirteen bare-parameter `IS NULL` optional filters that Postgres cannot type, and an `AND 1` sentinel.
- **Silent semantic changes**: `MAX(a,b)` in an upsert is scalar in SQLite and aggregate in Postgres; `substr(s,-1)` returns the last character in SQLite and the whole string in Postgres, so the `types=message.*` wildcard filter matches nothing and a long-poll on it hangs forever; and the published-fence read protocol takes a dummy `SELECT epoch FROM kernel_writer` to pin a snapshot, which works only because SQLite's `BEGIN IMMEDIATE` pins the file, and pins nothing under Postgres's default READ COMMITTED.
- **File-shaped guarantees**: rehearsal on a copy, pre-flip backup, restore with the close-handle protocol, backup drills and disk budgets are all file operations with no abstraction boundary behind them.

**Why not drizzle or a query builder.** The reviewers converged on keeping raw SQL, for three reasons that are stronger than the usual taste argument:

1. The live box has no type checker. Bun strips types; `tsgo` only runs in `bun run check` in the repo. A query builder's entire value is compile-time schema types, and that value is unavailable precisely where the code is edited, over `/api/fs`. A drizzle schema object also becomes a second thing that must be edited in lockstep with every migration.
2. Extensions get `ctx.db` as a raw SQL handle, and `POST /api/sql` hands agents the raw dialect. A builder in the kernel next to raw SQL everywhere else is two idioms in one editable tree.
3. The hard statements (the published-image `CASE` projections, the unread-count query, the FTS match) compose as SQL fragments. A builder needs escape hatches for every one of them, so you pay for the builder and still write the raw SQL at the hard spots.

"The DB may be dynamic" is not the reason; the reasons above are. But the execution is still wrong: raw SQL should sit behind the small dialect seam that `docs/tech.md` already designed and nobody built. The `database-interoperability.md` report specifies it: one `dialect.ts` of about 180 lines with fourteen helpers built on Effect's own `sql.onDialect` (`isDescendant` replaces 33 hand-rolled prefix matches, `jsonText` replaces 24 `json_extract`, `upsert` replaces 13 SQLite-only forms, `greatest` and `distinctFrom` fix the two silent-semantic sites), a `DbOps` service for the operations that are not statements (clone, restore, capacity), and both `user_version` ladders replaced with Effect's `Migrator`, which the app's editable migrations already use.

### Is this swappable for the bootloader too, or do I end up with two kinds of database?

You can have one engine for both stores. The design is in `database-interoperability.md` §B and §C. The short version:

- Rehearsal-on-a-copy stays a real candidate process against real data, populated by a logical dump into a scratch database rather than a file copy. Transactional-DDL rollback does not satisfy the spec, because you cannot hand an uncommitted schema to a separate child process for the self-test.
- Pre-flip backup ports cleanly: a dump after the drain is exactly as consistent as `VACUUM INTO` after the drain.
- Restore gets safer on Postgres: restore into a fresh database and switch the child's store descriptor, never renaming under a live reader. The keeper's closure receipt is still required on every engine, because an orphaned writer committing into an abandoned store loses acknowledged writes regardless of how the store is addressed.
- Same engine, two databases, two roles. The app role has no grant on the boot database, which is at least as strong as the file-ownership boundary. Keep the outbox on every engine; folding it into a `SECURITY DEFINER` function only works in one deployment shape and would leave two publication protocols.
- What weakens: the bootloader cannot see a managed Postgres volume's free space, so the store's disk budget is reported as unknown; and rehearsal time becomes a function of data volume with a configured budget and a distinct `rehearsal_copy_timeout` code.

Cost: roughly 2,000 lines added and 700 removed across 75 files, about a 10% net growth, and two to three weeks for all three engines or a week and a half for SQLite plus Postgres. Steps 1 through 4 (store descriptor, `DbOps`, `dialect.ts`, `Migrator` for both ladders) pay for themselves on SQLite alone in about a week and should happen regardless. The recommendation is Postgres next and MySQL designed-for but not shipped: it costs three schema contortions, five `RETURNING` rewrites and a search implementation with different tokenisation, for a user who does not exist yet. The report includes replacement text for SPEC §12, §3, §7.5 and §9 stating "one engine per deployment, two databases, two roles".

### How idiomatic is the Effect?

Scored per area against the real rc.113 surface. One correction to the brief: `Context.Service` is the documented v4 idiom, so the 23 service declarations are correct.

| Area | Score | Verdict |
| --- | --- | --- |
| Service definition | 4/5 | Right mechanism; shapes are inferred from `make` rather than declared, and `Auth` spreads five sub-services so nothing states what it exposes |
| Layer composition | 2/5 | Three nested `Effect.provide` tiers plus four null-holding `Ref`s in `boot/src/index.ts` |
| Typed errors | 3/5 | 15 `Schema.TaggedError` classes, zero throws; but the four most-used carry `code: Schema.String` while the rarely-used ones correctly use `Schema.Literals` |
| Error channel discipline | 2/5 | Every server route ends in a `catchCause` that flattens E to a string |
| Scope and resource lifetime | 5/5 | `child-keeper.ts` is textbook |
| HttpApi usage | 2/5 | Declared with full schemas, then 19 of 19 handlers are raw |
| Schema at boundaries | 4/5 | Every DB row decoded; every response `jsonUnsafe` |
| Stream, Queue, PubSub | 2/5 | Zero `PubSub`, zero `Latch`; 13 `Effect.sleep` poll loops, including the mutation drain inside the cutover window and the long-poll that re-runs its SQL query every 100 ms |
| `runPromise` inside services | 5/5 | None; all 15 occurrences are React effects |
| Concurrency | 4/5 | Semaphores for real gates, undercut by the poll loops and three mutable flags in `cutover.ts` that force three `Effect.die` calls |
| Module state | 5/5 | Zero module-level `let` or `var` anywhere |

The top eight rewrites, each sketched in a few lines, are in `effect-idioms-and-abstraction.md`. The first four are near-zero risk: one `jsonBody(schema, limit)` helper deleting ten copies (~125 lines); `Schema.Literals` on the five string-coded errors plus a `Record<code, status>` so a missing status is a compile error; one layer graph in `index.ts`; and one exported `committed` helper replacing four spellings of "commit the refusal" and five lint suppressions.

### Is it over-abstracted?

Not broadly. That reviewer traced `POST /api/messages` through thirteen hops and a source edit through eleven and could not find a hop that does no work; hops 3 to 6 and 12 are the two-process durable-cutover design, not abstraction. The ceremonial names mostly label real invariants: `closure` (a prior DB owner may still be alive), `publication` (committed row versus durably published event), `fence`, `proposal`, `transition`. `receipt` and `admit` are the two words that carry unrelated meanings and should be split.

The extension API is four members against pi's sixty-two, which is the opposite of over-abstracted. The problem is one level down: the context it hands out is a raw `SqlClient` plus a publication-fence protocol that a correct read must reproduce by hand. The shipped example spends nine lines of ritual (`SELECT epoch FROM kernel_writer`, take a `ceiling`, wrap a `publishedMessages` CTE) to count messages per agent. pi's first example is `pi.registerTool({name:"greet"})`. One `ctx.read(effect)` helper that opens the transaction, pins the epoch and exposes a pre-filtered `visible_messages` removes `ceiling`, `publishedThrough`, `publicationFence`, `kernel_writer` and `publishedMessages` from the agent's vocabulary. That is the single highest-leverage change per line in any of these reports.

Where comms is under-abstracted rather than over: the durable mutation protocol copied seven times, the body reader copied ten times, four idempotency tables for one concept, and the boot HTTP preamble copied seven times with the Origin check encoded slightly differently in each.

### API design for the consuming agent: bare minimum, too much, or too little?

The `api-design-for-agents.md` report walks the golden path from `/init` with only curl and inventories all ~46 operations.

**Too much in core** (about 735 lines of `packages/server/src` that pi would leave to an extension or a recipe): `GET /api/search` is literally `messages.list` with `recursive: true`; `GET /api/ctx` is 149 lines of product opinion (priority ordering, 200-message window, four UTF-16 units per token) that every harness will want to tune and that currently needs a cutover to change; reactions are a two-column table that needs no kernel privilege; topic delete encodes a sole-author policy; profiles beyond `/api/me` are board decoration.

**Too little**: no batch read-mark (catching up on ten topics is ten sequenced mutations minting ten global seqs); no "latest N" on `GET /api/messages` even though `newest` exists in the kernel; no way to fetch a message by `seq` (mutations take `id`, cursors and references use `seq`, the dual identifier the Sundial audit said not to copy); `/api/inbox` never advances its cursor on an empty match, so an idle inbox long-poll re-scans the whole board every 100 ms; no `POST /api/sql` writes, so the spec's data-surgery escape hatch does not exist; no topic move.

**Wrong shape**: inbox modes are an enum where they should be filters (`mentions=`, `exclude_self=`), so "everything mentioning me or under `project/**`" is not requestable; reads are per topic with ancestor rollup while events are global and flat, so "what have I not seen" has two incompatible answers; pages and topics have three authorities over one path (app `write` for messages, boot `fs` for pages, `meta.public` set by the app and enforced by boot); `POST /api/read` accepts `read` scope, so a read-only token can mutate and emit events.

**Contract consistency**: nine distinct response envelopes; `cursor` means three things (last returned seq, publication fence, effective read mark); omitted `since` defaults differ across four routes; the same error condition is `query_invalid` on messages and `cursor_ahead` on events; `retriable` is exactly `status === 503` everywhere, which is the useful bit and is fine.

**Docs**: eight concepts before a first successful post, two of which (scope names, error envelope) are not on the page at all. `host` becomes the instance label and accepts uppercase while home topics require lowercase, so the spec's own `$(hostname)` example on a Mac silently makes `mode=instance` match nothing. The version stamp header is implemented and forwarded and never mentioned, and its hash covers every extension registration so installing any extension marks every agent's copy stale. Ten of twelve adopted Sundial patterns are genuinely in the code.

The report ends with a proposed eleven-operation core, one cursor contract ("`cursor` is the highest seq the server considered, not the last item returned"), and a 56-line rewrite of `/init` that adds the four things a first-run agent has to guess today.

## Confirmed findings that matter most

Ranked by consequence. Every one was re-read by a skeptic; the id links to the full text in `adversarial-findings.md`.

1. **The extension boundary cannot carry schema or sequenced writes, so all product lives in the kernel** (SRV-1, SRV-2, SZ5, major). `ctx` has no mutation verb; the spec's `system` mirror and subscriptions cannot be written without raw `INSERT INTO messages`, which would corrupt the single-seq invariant. Either give extensions a migration hook and `ctx.messages.create`/`ctx.emit` on top of the existing serialized mutation helpers, so `ext/core.ts` can hold the §6 routes as the spec says, or rewrite SPEC §6 and §7.3 to say the kernel owns the product.
2. **HttpApi declared then bypassed, nineteen of nineteen** (SRV-1 in server quality, SZ3, major). Pick one: `.handle()` with the declared schemas, which deletes ~250 lines of hand parsing and makes unknown query keys a schema error; or drop HttpApi to a description table. Today the OpenAPI document advertises a looser `recursive` type than the parser accepts.
3. **Errors flattened to constants, defects reported as retriable** (SRV-4, SRV-12 in server quality, major/minor). `conversation-request.ts:42-70`: one message, two hints, and any `Die` from edited code becomes 503 `store_unavailable retriable:true`. The fix is `Schema.Literals` on `KernelError.code`, a `Record<code, {status, hint}>`, and a distinct non-retriable `handler_failed` that names the route.
4. **A long-poll can return 200 with a non-JSON body** (SRV-5, major). Status and headers are emitted before the wait loop runs; the loop calls the boot fence over HTTP every 100 ms with a 1.5 s timeout, so a slow boot mid-wait truncates the stream after whitespace heartbeats. Emit `{items:[],cursor:since,drained:true}` on failure inside the stream.
5. **Every read costs an uncached HTTP round trip to boot for the fence, inside the SQL transaction** (skeptic note on server quality, SRV-4 in server quality, major). Ten agents idling on `wait=60` put 100 requests per second of fence traffic on the same process that serves auth, edits and SSE; the UI multiplies it by fetching reactions per message, ~100 requests per topic view. Cache the fence per request or per tick, and advance it from the `/_boot/events/append` response boot already returns.
6. **The app outbox and four idempotency tables are never pruned and unindexed, and the relay full-scans them twice per mutation and ten times a second** (SRV-6, SRV-3 in server quality, major). Add a partial index on `shipped_at IS NULL`, delete shipped rows once boot has acknowledged, and bound the idempotency tables the way boot bounds `refresh_idempotency`.
7. **`/api/inbox` scans the whole message table in JavaScript and re-scans it every 100 ms while waiting** (SRV-7, major). `maxScan` defaults to infinity for every caller except `/api/ctx`, and `/init` runs one such scan on every session start.
8. **Crash-retry budget never resets, so three lifetime crashes silently demote the newest good generation** (BOOT-2, major). `tried` in `supervisor.ts:65` is only incremented. Three OOM kills weeks apart walk the box back to an older snapshot while `/data/app` still holds the newer code, with no event.
9. **The 10 s freeze budget wraps drain, backup, candidate migration and health together; overrun after the backup restores the store instead of returning `freeze_timeout`** (BOOT-6, F11, major). SPEC §7.7 says abandon before the backup. No `freeze_timeout` code exists.
10. **Boot event log is one JSON column; every filter is a `json_extract` table scan behind the single channel gate that message publication also needs** (DB-4, SEC-3, major). A `curl -N /api/stream?topic=x&since=0` on a week of traffic holds the gate for a full scan every 100 ms and starves `POST /api/messages`. SPEC §3 already specifies the indexed columns.
11. **A single read-scope `/api/sql` query can wedge the app process permanently, and nothing restarts a live-but-hung child** (SEC-5, major). The synchronous statement has no deadline that can fire, and the supervisor only replaces a child that exits.
12. **Agent-authored pages render raw HTML with no CSP on the human-session origin** (SEC-2, minor after verification). An `fs`-scoped agent can write a page whose script drives a passkey prompt the human will trust. Send the CSP the boot auth pages already send.
13. **Boot writes no `lock.*`, `fs.*` or `generation.*` events from the normal edit path** (BOOT-1, minor). The `EditLock` service returns typed transitions and `edit-http.ts` discards them, so the spec's "wait on `lock.released`" hand-off between two agents cannot work and a failed reload is invisible to `/api/ctx`.
14. **A failed source-publication replay wedges the whole edit path with no HTTP remedy** (skeptic note on boot conformance). Every public source operation is guarded by `journal.ready`, which fails on a `publishing` row, and only `journal.recover` at startup clears it. Combined with the deliberately fail-closed keeper-receipt case (F1, refuted as spec-mandated), this is the state to give a human-only, assertion-bound escape hatch.
15. **No OS ownership boundary: boot, app and the Vite build share one UID** (BOOT-4, SEC-1, downgraded to note because `docs/deployment.md` documents it and states it is not §7.9). It still means the "the app cannot open `boot.db`" recovery-table row is false today and should not be asserted in `/init` or `/_boot` help until the privileged keeper exists.
16. **The child can forge boot-owned audit events** (skeptic note on trust boundary). `/_boot/events/append` validates sequencing and ownership and inserts the record verbatim, with `type`, `actor`, `instance` and `level` as free-form strings. Editable code can append `auth.failed` or `lock.broken` events attributed to boot.

Structural findings already covered in the answers above: the seven-copy mutation protocol (SZ2, SRV-2 in server quality), the four idempotency tables (SZ4), the six cycle-breaking `*-schema.ts` files (F9, SZ9), the nested-ternary status tables (F5), the duplicated child IPC schema across the process boundary (F3), the duplicated commit-time authority check (F2), the UI's absent state layer and per-component polling (SRV-5 in server quality), Tailwind shipped in the live rebuild closure with zero utility classes used (SRV-6 in server quality), no UI tests including for the markdown sanitiser (SRV-7 in server quality), and `runtime/package.json` duplicating the workspace manifests with nothing enforcing parity (SRV-8 in server quality).

## Refuted or downgraded, for the record

- **F1, lost keeper receipt plus pinned cutover is permanently unrecoverable.** The code does exactly that, but SPEC §7.1 mandates it: "if the keeper itself dies before recording closure, fail closed with boot diagnostics". Refuted as a spec violation; kept above as the case that deserves an explicit human escape.
- **F4 and SRV-3, `/_boot/agents` as a third channel operation.** Real, but documented as a deliberate narrow extension in both package READMEs. Note, not major. The eight hardcoded `"rahul"` literals inside it, one in a SQL string, are still worth one constant read from settings.
- **DB-2, DB-3, DB-5, DB-6, DB-7, DB-8, DB-9.** All accurate readings of the code, refuted as *findings* because they describe what breaks on a backend that does not exist, and the PR body admits remote backends are unfinished. They are the inventory for the interoperability work, not defects in this PR. DB-8 specifically: the seq allocator's read-modify-write is safe today because it runs inside one serialized SQLite transaction.
- **SRV-12 in server conformance, missing move, sql writes and system view.** All three are documented deferrals.

## What is good and should not be refactored away

- `packages/boot/src/child-keeper.ts`: scoped child ownership with a durable closure receipt written in a finalizer, parent-pipe EOF as the kill signal. The best file in the tree.
- `packages/boot/src/edit-lock.ts`: exhaustive `Schema.Literals` codes, and the `admit` combinator that returns the domain rejection as a value so expiry cleanup commits even when the request is refused, with the reason stated in a comment.
- The source publication journal: before and desired images committed first, exclusive sibling temporaries, fsync, rename, ancestor fsync, and recovery that accepts either recorded image and refuses a third state.
- The writer-epoch fence via conditional `UPDATE ... RETURNING`: engine-neutral by construction and stronger on Postgres than on SQLite.
- Credential handling end to end: `__Host-` cookie, exact-Origin checks on every unsafe route, no bearer-to-cookie fallback, header stripping on lowercase-normalised names, child surface gated on a constant-time secret plus exact `Host` plus absence of forwarding headers, `--frozen-lockfile --ignore-scripts` on every install.
- The comments that cite *why* an invariant holds rather than narrating what the code does. pi has no equivalent, and they are the single thing most likely to stop an agent from breaking a guarantee.

## Decisions taken while reading this review

Each is recorded first in [`pr-comments.md`](pr-comments.md), the doc that becomes the final PR review, and then mirrored into `SPEC.md` §12 (uncommitted).

- **Read marks are automatic, or gone.** The owner's call, recorded in `pr-comments.md`: agents never post `POST /api/read`. The server already knows the last thing it handed each instance, so the mark advances on view (with `?mark=0` for peeking), is a plain upsert with no seq or event unless it moves, and the explicit route survives only as a human rewind or is removed with the concept. Unread is a human-board concern; an agent carries its own `since` cursor. This closes the batch-mark, `read`-scope-mutates, and messages-versus-events cursor findings in the API chapter, and drops one of the eight concepts before a first post.

- **Extension routes stay top level.** No `/api/ext/<name>/` namespace. Extensions are not a second tier: `core.ts` must be able to own and override `/api/messages`, the same way pi extensions register into the built-in space. Ownership is discoverable from `GET /api/ext`, collisions fail the later extension with `ext.failed`, boot paths stay reserved, and one root per multi-route extension is convention only. Recorded in `pr-comments.md`.

- **No reactions in the core.** Removed from SPEC §3, §6 and phase 4. They were a Slack habit in the primitives list; in this PR they cost ~210 server lines, a table with publication bookkeeping, a fourth idempotency table, an event type and the per-message UI fetch behind the hundred-requests-per-topic finding. Anyone who wants them writes a twenty-line extension over `kv`, or uses a message convention with `meta`. Recorded in `pr-comments.md`.

- **No inbox route, no digest route, no token budget.** `GET /api/messages` is the one read primitive and gains `mentions=`, `exclude_self=1` and `newest=1`. The inbox is a recipe over it shown in `/init`; the digest becomes `examples/extensions/digest.ts`; budgets are not a default concern and `limit=` is the only sizing knob on core routes. This also ends the ctx-versus-pages naming: "pages" is the only name, the ctx project is an attribution, and `ctx` survives only as the extension handler context. Recorded in `pr-comments.md`.

- **Use the declared HttpApi and type the errors.** Confirmed. All nineteen handlers move to `.handle()` with their declared schemas; error codes become `Schema.Literals` with one status-and-hint record per module; a handler defect is 500 `handler_failed`, never a retriable 503. Recorded in `pr-comments.md` items 5 and 6; spec text pending.

- **Extensions can do anything except break the bootloader.** Confirmed, and it is the only boundary. `ctx.messages.create`, `ctx.topics.meta`, `ctx.emit`, `ctx.read`, `api.migrate`; product routes move to `ext/core.ts`. Recorded in `pr-comments.md` item 7; spec text pending.

- **Fix the long-poll.** Confirmed. Always return the envelope, and wait on a commit signal instead of re-querying every 100 ms. Recorded in `pr-comments.md` item 8.

- **One `mutate()` combinator.** Confirmed. The seven hand-copied write protocols collapse onto `operational-events.ts`'s shape, and the four idempotency tables become one. Recorded in `pr-comments.md` item 9.

- **Every remaining major defect gets fixed.** Confirmed as a block: fence caching, outbox index and pruning, crash counter, freeze budget, event log columns, SQL timeout plus a boot watchdog for hung children, boot events, public pages, CSP, duplication cleanup, UI state model. No UI tests. Findings made moot by the deletions are listed in `pr-comments.md`. Only two decisions remain open: what leaves the bootloader (audit in progress) and one engine for both stores.

- **The bootloader keeps only what a bootloader does.** Confirmed at the audit's recommended cut: six jobs and nothing else. Boot is 9,585 lines now, lands at about 8,450 after the safe step and about 7,250 after the moves (watcher, SSE, topic move, backup schedule, public-page semantics out). Four weakenings accepted under the rule; keeping the `http.request` record is the one open call. Recorded in `pr-comments.md` item 21.

- **Adopt the API review's minimal core.** Confirmed with amendments: eleven operations, one cursor contract, `:ref` takes a seq, sql writes under `fs`, the manifest fixed, the `/init` rewrite minus read marks. Recorded in `pr-comments.md` item 22.

- **One engine per deployment for both stores.** Confirmed with the report's default: descriptor, `DbOps`, `dialect.ts` and `Migrator` first on SQLite, then Postgres with pglite in CI; MySQL designed for, not shipped. Recorded in `pr-comments.md` item 23 and SPEC §3, §7.5, §9, §12.

All twenty-three items are now confirmed and mirrored into `SPEC.md` and `docs/tech.md`, uncommitted.

## Suggested order of work

1. **Decide two spec questions and write them down**: which of boot's eleven concepts must be immutable, with the real line count replacing "a few hundred lines"; and one engine per deployment for both stores, using the replacement text in `database-interoperability.md` §E.2.
2. **Fix the boundaries** (about two days, near-zero risk to guarantees): switch the nineteen handlers to `.handle()`, or drop the declarations; `Schema.Literals` on the five string-coded errors with a `Record<code, {status, hint}>`; one `jsonBody` helper; a non-retriable `handler_failed`; make the long-poll stream failure-proof.
3. **Fix the three scaling defects** before any board accumulates history: index and prune the outbox, push the inbox match into SQL with a bound, cache the boot fence per request and advance it from the append response.
4. **Fix the two bootloader bugs**: reset the crash counter on a healthy start, and scope the freeze budget to the drain with a real `freeze_timeout`.
5. **Give the extension boundary teeth**: `ctx.read(...)`, `ctx.messages.create`, `ctx.emit`, and a per-extension migration hook; then move search, ctx, reactions, profiles-beyond-me and topic-delete into `examples/extensions/` and shrink the core to the eleven operations in `api-design-for-agents.md` §E.
6. **Collapse the duplication** in this order: one `mutate()` combinator (seven copies), one idempotency table (four), one layer graph in `index.ts`, one `committed`, one `bootRoute` preamble, fold the `*-schema.ts` files, rename the three `admit`s.
7. **Storage steps 1 through 4** from the interoperability report: store descriptor, `DbOps`, `dialect.ts`, `Migrator` for both ladders. Green on SQLite throughout, about a week, and they pay for themselves before any second engine exists.
8. **Then Postgres**, with pglite in ordinary CI and a gated container job for the concurrency tests the fence needs.

## Validation claims, measured

Full transcript in [`validation-run.md`](validation-run.md). Run on the working tree at `4885295`.

| Command | Result |
| --- | --- |
| `bun run check` | Pass. Format, lint, typecheck and the import-boundary invariants all clean, 2.4 s. |
| `bun run test` | **One failure.** 297 passed, 1 failed, across 85 files in 118 s. |

The PR body claims 289 tests across 82 files all passing. The tree now has 298 tests in 85 files, and one is flaky: `public-pages.test.ts` ("opens only exact opted-in page topics") returned 503 where 200 was expected, and re-running it three times gave pass, pass, fail. The root cause is a real bug, not a test problem. In `public-pages.ts:127` the anonymous read path fails immediately when any app publication is still pending, while the sibling write path in the same file loops with a one-second deadline for exactly that condition. In production that is an anonymous public page that flickers 503 in proportion to write traffic. It compounds with SEC-6 and BOOT-9 above: the same read also takes the single-permit operation gate that `cutover.reload` holds for the whole reload, so public pages are down for the duration of every edit, against SPEC §7.7's "reads keep flowing".

`scripts/check-invariants.ts` is meaningful but narrower than its name: it enforces the one-directional package import chain and bans imports of the vendored repos, which is the only mechanical guard on the trust boundary. It does not check the other AGENTS.md rules (no barrels, file size, module-level state).

## Method and caveats

Seven Opus finders, one per dimension, each followed by one Opus skeptic who re-read every cited line and either confirmed, downgraded or refuted; one Opus claims-checker running the repo's own checks; three further Opus reviewers for Effect idioms and abstraction, agent-facing API design, and database interoperability; synthesis by this session. Sixteen agents in total.

The branch received two commits during the review. The API report notes HEAD moved to `4246e30`, which among other things added a backup inventory route and page-archive enforcement; the boot conformance finding BOOT-5 (no backup listing or restore route) may be partly addressed by that commit and should be re-checked against the current head. All other line references are against `b9d6f28`.

Not covered: no reviewer ran the compiled browser or reload smoke flows the PR describes, and nobody measured a dump-and-load rehearsal against realistic data volume; both the read-isolation hazard under Postgres and the freeze-budget overrun are correctness arguments from reading, not observed failures.
