# chirp reduction plan

Worktree audited: `origin/master` @ `1156548` (detached, read-only). All line counts below are `wc -l`
against that tree. Sixteen agents worked this: eight proposed deletions, eight tried to prove each one
load-bearing. Ten proposals survived; fifty-seven did not. This is the executable residue, sequenced.

Read §1 before anything else. The headline is not the one the brief expected.

---

## 1. The headline

**Measured now** (`find packages examples scripts -name '*.ts' | grep -v /test/ | xargs wc -l`):

| | files | lines |
|---|---|---|
| production TypeScript | 261 | **23,844** |
| of which `packages/boot/src` | 101 | **13,536** |
| of which `packages/server/src` | 92 | 7,315 |
| of which `packages/storage/src` | 9 | 810 |
| of which `packages/protocol/src` | 20 | 761 |
| tests (`packages/*/test`) | — | **40,544** |
| the four docs in scope | — | 4,019 |

(The brief's 25,800 counts `.sh`/`.sql`/`.tsx` too — 27,220 over 277 files. The 261-file production
TypeScript count matches exactly. I use the TypeScript figure throughout so the before/after is comparable.)

**What this plan removes**, de-duplicated across the ten surviving proposals (E-2 and S-9 are the same
cut; D-1, D-7 and O-5 are all subsets of R-1; overlaps are counted once):

| | lines |
|---|---|
| production TypeScript deleted | **729** |
| production TypeScript relocated boot → app | 125 |
| tests deleted | **1,206** |
| build / CI / patch deleted | **231** |
| docs deleted | **4,019** |
| **total lines removed from the tree** | **6,185** |

**Resulting totals:** production 23,844 → **23,115** (−3.1%). Tests 40,544 → **39,338** (−3.0%).

**Boot against its budget.** SPEC.md:401 budgets the immutable core at "about 6,000 to 7,000 lines, of
which roughly 2,300 are durability machinery". Boot is 13,536. This plan takes **262 lines** out of boot:

| | lines |
|---|---|
| `boot-write-lock.ts` + call sites (Step 4) | 17 |
| engine columns, literals, migration 18 → named no-op (Step 4) | 65 |
| pg/mysql arms at boot's `dialect` call sites (Step 4) | 10 |
| legacy store adoption (Step 6) | 45 |
| account/token/passkey listings, relocated to the app (Step 7) | 125 |
| **boot after this plan** | **13,274** |

That is 1.9%. Boot stays roughly **2x its budget**, and no further deletion in this audit closes the gap.

**Say this plainly to the owner, because it is the actual finding.** Sixteen agents read every line of
boot. The deletions that survived adversarial defence remove 262 lines from it. The large reductions this
plan does deliver — 729 production lines, 4,019 doc lines — are almost entirely in `packages/storage`,
CI and design documents, not in the immutable core. Boot is not big because of dead code. It is big
because job 2 (authenticate: credentials, refresh rotation, passkeys, minting) is ~2,464 genuinely
required lines, and job 4 (snapshot/swap/rollback) is ~5,275 lines against a "roughly 2,300" budget, of
which ~1,460 is the nine-mechanism liveness-proof cluster that §3 below shows cannot be reduced one
member at a time.

Two things follow, and both are owner decisions rather than agent work:

1. **SPEC.md:401's number is wrong or the design is.** Either the budget becomes ~9,500 with the
   liveness proofs named as its largest line item, or the owner commissions a deliberate consolidation of
   the nine proofs into one receipt protocol. Leaving a 7,000-line budget in the spec while boot runs at
   13,274 is how the next 4,000 lines get justified one review finding at a time.
2. **The previous audit worked and changed nothing.** Every cut `docs/pr-1/boot-audit.md` named was
   taken — the drill, the roster, the storage walker, the watcher, the QR dependency, topic move, the
   backup schedule — and SPEC.md:696 ratified all of it. Boot went from 9,585 to 13,536 in the same
   period. Deletion is a one-time subtraction from a process that adds continuously. The durable fix is
   §9's merge-time test, not this plan.

---

## 2. Cut the requirements first

One requirement generates almost everything worth deleting in this audit: **multi-engine portability**.
It is unattributed to the owner — `SPEC.md:689` says "Decided 2026-09-10" and asserts "All three are
shipped and tested", and it is the same sentence that authorised the 4,771-line row-by-row transfer tool
whose PR was already closed once traced. The owner's only recorded word on the subject is ledger item 64
(`docs/pr-1/pr-comments.md:501`, "Decided by the owner"): *"The dominant line item is the optional one.
Engine portability is roughly 20,000 lines once #9 and #10 land, for a board that runs on SQLite, on one
machine, for one human and their agents."*

That is a measurement note, not a repeal. **The spec edits below are the owner's to make, not an agent's**
(`AGENTS.md`: "Flag disagreements with the spec rather than silently changing behavior";
`docs/boot-ownership-audit.md:9` records that owner SPEC/tech/PR-review documents are not edited by this
ledger). Steps 2–4 are blocked on the owner striking them.

### Step 0 — Owner decisions (gates Steps 2, 3, 4, 6)

Three questions, in this order:

1. **Is running this board on Postgres or MySQL a requirement you hold?** If no, strike the sentences
   below. If yes, none of Steps 2–4 happen and `dialect.ts` is the cheapest part of getting there.
2. **Does any volume you care about have `comms.db` at the data root rather than under `store/`?**
   The check is `ls /data/comms.db` on the box. Gates Step 6.
3. **`SELECT count(*) FROM outbox WHERE shipped_at IS NOT NULL` on the live app store, and is any
   retained generation snapshot or restorable backup running app source from before the
   acknowledge-then-delete outbox landed?** Gates Step 5a.

### Step 1 — Strike the sentences (owner; 0 lines of code)

| location | action |
|---|---|
| `SPEC.md:72` | §3 heading "(two stores, any Effect SQL backend)" → "(two stores, SQLite)" |
| `SPEC.md:74` | whole paragraph. Replace with: two stores behind Effect's `SqlClient`, SQLite files under `/data`. Drop `DATABASE_URL`/`BOOT_DATABASE_URL`. |
| `SPEC.md:360` | drop the "For SQLite," qualifier on the writer-epoch paragraph — it is now the only case |
| `SPEC.md:543` | drop "or restore into a fresh database and switch the child's store descriptor on Postgres and MySQL" |
| `SPEC.md:609` | drop the final sentence ("On Postgres or MySQL the same boundary is a separate schema and a separate role…") |
| `SPEC.md:640` | drop "optionally `DATABASE_URL` and `BOOT_DATABASE_URL`…" through "…names the server and the first database only" |
| `SPEC.md:689` | **whole §12 bullet.** This is the regeneration mechanism: while it stands, any reviewer reading the spec correctly reports the code as incomplete and closes the finding by adding machinery. Replace with one paragraph: chirp runs on SQLite; the engine seam is `dialect.ts` plus the client factory; a second engine is not a current requirement. |
| `SPEC.md:690` | **whole §12 bullet** ("Every file-shaped guarantee has a named engine-neutral form"). This is the sentence that produced `DbOps` as an engine-neutral service, the three-value `engine` column and the per-engine artifact extension. Keep the two clauses that are live and SQLite-specific: positive keeper closure evidence before any restore, and rehearsal running a real candidate with the full self-test against a real copy under a configured budget that fails with `rehearsal_copy_timeout`. |
| `.env.example:7-8` | delete both lines — they advertise two variables read by no line under `packages/*/src` |

**Guarantee it must not break:** none — no code changes. **How to tell:** `grep -rn 'DATABASE_URL' SPEC.md .env.example` returns nothing.

### Step 2 — Delete the cross-engine design documents (1,851 doc lines)

```
docs/database.md                        1,421
docs/pr-1/database-interoperability.md    430
```

**Behaviour lost:** the written record of how each engine compensates for MySQL's missing transactional
DDL, partial indexes and `RETURNING`, and the per-engine method table for `DbOps`.
**Why acceptable:** deleting the implementation without deleting its authority is how the track comes
back. `SPEC.md:689` names `docs/pr-1/database-interoperability.md` as "the draft" and `docs/database.md`
as where MySQL's weaknesses "are each compensated" — both references die with Step 1.
**Guarantee:** none. **How to tell:** `grep -rn 'docs/database.md\|database-interoperability' SPEC.md docs packages` returns only historical review prose under `docs/pr-1/`.
**Do this before Step 3** so nobody is tempted to keep the code because a doc still describes it.

### Step 3 — Delete the remote-engine client stack, its tests, its CI matrix and the mysql2 patch (1,436 lines)

Production (419):
```
packages/storage/src/remote-client.ts      80
packages/storage/src/remote-driver.ts     104
packages/storage/src/remote-inspector.ts   85
packages/storage/src/remote-session.ts     98
packages/storage/src/remote-values.ts      52
```
Tests (786):
```
packages/storage/test/remote-json.test.ts            64
packages/storage/test/remote-session.test.ts         58
packages/storage/test/remote-sessions.test.ts        85
packages/storage/test/remote-values.test.ts          83
packages/storage/test/mysql-pool-cleanup.test.ts     34
packages/storage/test/fixtures/remote-sessions.ts   311
packages/storage/test/fixtures/mysql-failing-pool.ts 16
packages/storage/test/fixtures/mysql-pool-probe.ts    8
packages/server/test/kernel/remote-dialect-semantics.test.ts  17
packages/server/test/fixtures/remote-dialect-semantics.ts    110
```
Build/CI (231):
```
.github/workflows/remote-sessions.yml                        46
scripts/remote-session-acceptance.sh                        107
patches/@effect%2Fsql-mysql2@4.0.0-rc.113.patch              78
```
Plus the `@effect/sql-pg` and `@effect/sql-mysql2` entries at `packages/storage/package.json:19-20` and
the patch entries at `package.json:39` and `packages/server/runtime/package.json:39`.

**Behaviour lost:** nothing at runtime. What is lost is the *harness*: the proof that a future
Postgres/MySQL client would pin one physical inspector connection, register every borrowed lease, and
refuse to proceed unless `pg_stat_activity` / `performance_schema` shows zero surviving sessions
(`remote-inspector.ts:56-81`), plus the integer-safety and JSON codec guards in `remote-values.ts`, plus
a 3-way CI matrix spinning Postgres and MySQL on every pull request.
**Why acceptable:** `packages/storage/src/store.ts:33` — `if (/^(postgres|postgresql|mysql):/i.test(raw))
return yield* new StoreError({ code: "store_engine_unsupported" })`. No production path can hold a
`RemoteStore`. Every `SqlClient` built in production is SQLite (`boot/src/index.ts:79`, `db-ops.ts:33/67/108/129`,
`app-recovery.ts:99`, `app-store-layout.ts:101`, `sqlite-copy-worker.ts:18`, `server/src/server.ts:248`,
`kernel/sql-read-worker.ts:54`). The package's own doc says it: `packages/storage/docs/README.md:13` —
"The experimental `remote-client`, `remote-inspector`, and `remote-session` exports are not wired to
boot, descriptors, migrations, or the board." And `assertNoSessions` is boot re-deriving over SQL a
liveness proof that on a managed Postgres belongs to the provider. If the Postgres path is ever resumed,
the right shape is a store descriptor naming the engine plus a client factory picking a driver (~40 lines),
not a 419-line session-ownership protocol.
**Guarantee:** none. Boot's closure proof is child-attempt receipts plus `kernel-boot.ts`;
`remote-inspector.ts` is never in that graph.
**How to tell:** `grep -rn 'remoteClientLayer\|remoteInspectorLayer\|RemoteInspector\|remote-driver\|remote-values' packages | grep -v node_modules`
returns nothing; `@effect/sql-pg` and `@effect/sql-mysql2` appear in no `package.json`; typecheck and the
storage + server suites pass.

### Step 4 — Collapse the remaining engine seam (211 production lines: 130 in storage, 81 in boot)

**4a. `packages/storage/src/store.ts` remote surface — 64 lines.** Delete `RemoteStore` (`:8-13`),
`validDatabase` (`:53-54`), `parseDescriptor` (`:56-76`), `withDatabase` (`:78-89`), `asBoot` (`:91-110`),
and the non-file arm of `render` (`:113-114`). Drop `store_engine_mismatch` from the `StoreError` code
literal; **keep `store_engine_unsupported`** — `parse()` at `:31-33` is the enforcement point for the whole
decision and must keep rejecting a `postgres:`/`mysql:` descriptor by name. Remove the remote arms of
`packages/storage/test/store.test.ts` (175) — roughly 60 lines. The comment at `:56`, "Parse the future
remote configuration without enabling it in SQLite-only callers", is the tell.

**4b. `packages/boot/src/boot-write-lock.ts` — 17 lines.** Whole file (13) plus the two call sites at
`edit-lock.ts:185`, `:399` and the import at `:1`. `boot-write-lock.ts:12` is
`on(sql, {sqlite: () => Effect.void, pg, mysql})` and only the sqlite branch is reachable.
**Preserve the documented rule before deleting**: `boot-write-lock.ts:5-7` records that the `seq` row lock
is taken *first*, because auth and editing publish events inside their own transaction. Move that comment
onto `events.ts:93` (`lockRow`), which is boot's other `FOR UPDATE` site, so the ordering rule survives
the file.

**4c. `dialect.ts` pg/mysql arms — ~40 lines, file stays.** `packages/storage/src/dialect.ts` (118) is
imported by 25 production modules; `isDescendant`, `jsonText`, `jsonInt`, `jsonArrayHas`, `replacePrefix`,
`greatest`, `plannerHint` and `readTransaction` are the SQL the board runs on, and `readTransaction`
(`:103-118`) additionally carries engine-independent nested-transaction detection used by `pages.ts`,
`extension-data.ts` and `read-snapshot.ts`. **Do not delete the file.** Collapse the pg and mysql arms of
the twelve helpers and the three-way arm of `readTransaction` at `:109-114`. Then collapse the 12 inline
`on(...)` call sites: `read-marks.ts:14`, `extension-data.ts:71`, `pages.ts:164`, `public-page-policy.ts:46`,
`published-messages.ts:10-11`, `published-topics.ts:7`, `topic-move.ts:94/119/126`, `system.ts:12`,
`events.ts:101` — ~25 physical lines, of which ~10 are in boot. Collapse
`packages/storage/test/dialect.test.ts` (153) from a three-dialect matrix to sqlite only — ~100 lines.

**4d. Engine columns and the migration ladder — ~65 lines.** `backup-metadata.ts:7`,
`backup-inventory.ts:8`, `app-store-identity.ts:50`, `database-restore-auth.ts:40`, and `db-ops.ts`'s
`backup_engine_mismatch` path. **`boot-schema.ts:199` cannot be deleted from the ladder.**
`packages/storage/src/migrations.ts:38-49` validates `step.id !== index + 1` and checks recorded names,
raising `migration_ledger_name_mismatch`. Step 18 `backup_engine` must become a **named no-op** exactly the
way step 19 already is — `{ id: 19, name: "sqlite_copy_ownership", run: Effect.void }` — and the `engine`
column stays in any store an earlier image created unless a step 20 drops it. This is a migration, not a
deletion, and it is cheap only under the condition ledger item 36 asserts: there are no deployed stores.

**Guarantee:** 1 (no acknowledged write lost). The engine columns are metadata on backups and identity;
4d changes what boot records, not what it preserves. The risk is the ladder, not the columns.
**How to tell:** boot's migration tests pass against `packages/boot/test/fixtures/boot-schema-history/*.sql`
unchanged; `boot-schema-history.test.ts` adopts every historical fixture against today's initializer; a
fresh boot and a boot against a v18 fixture both reach ready; `grep -rn "'pg'\|\"mysql\"\|postgres" packages/*/src`
returns only `store.ts:33`.

---

## 3. Then the duplicates — **nothing is removed, and that is the result**

The brief's first named cause was duplicate answers to "is the previous owner really dead". Four
proposals attacked it (B-4 the second rollback copy, B-5 the three keepers, B-9 the sqlite-copy intent
journal, and the closure-protocol extraction). **All four were defended.** The minimum ownership and
closure set is therefore the full set, and this section exists to say so explicitly so nobody spends
another audit cycle on it.

| member | file:lines | the failure it is the only answer to |
|---|---|---|
| process-group closure probe | `child-keeper.ts:69-97`, `preparation-keeper.ts:76-108`, `sqlite-copy-keeper.ts:36-65` | proves no process can still write the app store; ESRCH-only absence is what licenses boot to replace the file |
| keeper receipt (atomic `wx 0600` → writeAll → fsync → rename → fsync dir) | `child-keeper.ts:18-28`, `sqlite-copy-keeper.ts:67-82` | boot dying between the kill and the confirmation |
| kernel boot-id check | `child-attempts.ts:36-62` | power loss: closes attempts whose proof cannot exist. **SPEC.md:696 lists it under "Stays".** |
| writer-epoch CAS | `SPEC.md:360`, `app-recovery.ts` | a stale child that is alive and holds a handle — rejected at the SQL layer, which the process layer cannot do |
| publication fence | `events.ts:151-163` | makes outbox re-ship idempotent; a `published` record replays against retained events and returns success |
| sqlite-copy intent journal + receipt | `sqlite-copy-process.ts:91-104`, `:62-75` | budget enforcement against a **synchronously blocked** SQLite worker — nothing else in the tree provides this |
| adoption record | `app-store-identity.ts` | prevents silently recreating a missing app store |
| restore-before-image manifest | `restore-before-image.ts` (191) | the **only** preserved copy of the original bytes on the offline path, where `backup.capture` cannot run (`database-backup.ts:50` `backup_live_child_required`) |

The one reduction available here is a **refactor, not a deletion**, and it is optional: extract
`closure-proof.ts` (ESRCH probe + kill-and-confirm loop + atomic receipt writer, ~55 lines) and
`receipt-recovery.ts` (boot-id short-circuit + receipt poll, ~30 lines), netting ~100 boot lines with zero
behaviour change. **Do not do this as part of this plan.** See §7 for why merging the keepers specifically
is dangerous; extracting a shared *library* the three keepers call is safe in a way merging their *entry
points* is not, but it is still surgery on the most load-bearing code in the tree and it belongs in its own
change with all three keeper suites pointed at the extracted helpers and passing unchanged.

---

## 4. Then the misplaced code

### Step 7 — Move boot's account and credential **listings** to the app (125 boot lines)

This came from a defender's "missed" report, not from a proposal, so it has been argued once and
defended zero times. Treat it as the highest-value item that still needs a defence round.

Move out of boot, keeping the tables and the authentication reads where they are:
```
packages/boot/src/account-queries.ts   50   GET /_boot/enrollments, GET /_boot/tokens (two SQL snapshots, a nine-column GROUP BY over token families)
packages/boot/src/account-http.ts      23
packages/boot/src/token-http.ts        37
packages/boot/src/passkey-management-http.ts — the list route only  ~15
```
Plus their descriptors in `route-discovery.ts` and the matching lines of the `proxy.ts:30-60` help string.

**Destination:** app routes over the same tables, or a core extension. Job 2 of the six is
"authenticate", and authenticating a request needs two reads: a bearer token against `tokens` and a
session cookie against `sessions`. It does not need a paginated roster. `SPEC.md:696` puts "listings" out
of boot in the same sentence as policies, caches and rendering.

**Do not move passkey add/delete** (`passkey-management.ts` 151, `passkey-management-schema.ts` 56,
the mutation routes in `passkey-management-http.ts`) — ~240 lines. `/setup` closes after first setup
(`setup_closed`, `auth-http.ts:98`), so this is currently the **only** way for the human to enrol a second
device's key, and losing the sole registered key with no second one enrolled is a permanent lockout. That
is guarantee 3. Moving it requires the owner to first say how a human recovers a lost sole passkey.

**Guarantee:** 3 (a human can always get back in). `account-queries.ts:29` defends itself in-file —
"Human account metadata remains readable without an app" — which is a guarantee-3 argument, though a weak
one: reading a token roster is not getting back in, and `GET /_boot`, `/setup`, `/approve/*` and the
recovery page are untouched.
**How to tell:** with the app deliberately killed, `GET /_boot` still answers, the recovery page still
loads, and a human session can still reach `/approve/*`. `GET /api/accounts` (new) returns the same rows
the old `/_boot/enrollments` did. The app's `/api` OpenAPI document still decodes boot's manifest
(`server/src/discovery.ts:19`) — **the manifest itself is not touched by this step**; see §7, B-2.
**Sequencing:** the app-side route must exist and be reachable *before* the boot route is deleted, or
there is a window with no way to list credentials at all.

---

## 5. Then the over-general abstractions and the dead code

These are independent of each other and of Steps 1–4. Do them in this order only because it puts the
blast radius in ascending order: protocol, then app, then boot.

### Step 5a — `shipped_at` and the second outbox drain loop (22 lines, app)

```
packages/server/src/kernel/outbox.ts:14   shipped_at in the Rows schema
packages/server/src/kernel/outbox.ts:47   the `shipped` field
packages/server/src/kernel/outbox.ts:59   WHERE shipped_at IS NULL
packages/server/src/kernel/outbox.ts:73-83  the 11-line "upgrade backlog" drain loop
packages/server/src/kernel/mutate.ts:92   the trailing ,NULL
packages/server/src/kernel/read-snapshot.ts:66  shipped_at IS NULL AND
packages/server/src/ext/core/schema.ts:127 and packages/boot/src/app-recovery.ts:34,46  identity probes
packages/server/src/ext/core/legacy-idempotency.ts:78  the outbox_unshipped partial index
```
**Behaviour lost:** nothing. Nothing in `packages/*/src` ever writes a non-NULL `shipped_at` —
`mutate.ts:92` inserts `NULL` and there is no `UPDATE … SET shipped_at` outside test fixtures. So loop 1
at `:59` drains the entire table and loop 2 at `:73-83`, which only reaches rows loop 1 left behind,
can never find one. This is the residue of a two-phase ship-then-mark outbox that
`docs/pr-1/adversarial-findings.md:116` asked to replace with acknowledge-then-delete; the replacement
landed and the first design's column, field, index and drain loop stayed.
**Leave the column in the DDL** (`boot/src/app-recovery.ts:46`, `SPEC.md:108`) and simply stop referencing
it — no migration, no `ALTER`.
**Delete both loops or neither.** `outbox.ts:86-97` prunes expired idempotency receipts only
`WHERE NOT EXISTS(SELECT 1 FROM outbox)`. If you keep loop 1's filter and delete loop 2, shipped rows are
stranded permanently and the receipt table grows without bound forever. Also note what loop 2's
`count < 16` bound and `onRemaining` reschedule were for: a large backlog must not monopolise the mutation
permit. Loop 1 is unbounded, which is fine only because it never has a backlog — if that assumption ever
changes, loop 1 needs the bound, not a second loop.
**Guarantee:** 1. Re-shipping is safe: `boot/src/events.ts:151-163` handles `record.state === "published"`
by validating the replay against retained events and returning `{published_through: current.published_through}` —
a success, not an error — and nothing deletes from `event_batches`.
**Condition (Step 0 q3):** `SELECT count(*) FROM outbox WHERE shipped_at IS NOT NULL` is 0 on the live
store, **and** no retained generation snapshot or restorable backup runs app source from before the
acknowledge-then-delete change. `docs/pr-1/adversarial-findings.md:917` confirms an earlier version of
this codebase did `UPDATE … shipped_at`, so the wider check is not theoretical.
**How to tell:** post-change, publish a message, kill the child mid-relay, restart, and confirm the event
appears exactly once in `GET /_boot/events` and the outbox drains to empty.

### Step 5b — Four kernel error codes nothing can produce (24 lines, protocol) [E-2 = S-9]

```
packages/protocol/src/error-code.ts:19,20,23,24
packages/protocol/src/errors.ts:191-195, 196-200, 206-210, 211-215
```
`health_context_invalid`, `health_create_invalid`, `health_response_too_large`, `health_route_failed`.
Verified: each appears exactly twice in the repository — its own literal and its own five-line policy
record. Zero construction sites in production, tests or fixtures. The live probe
(`packages/server/src/kernel/health.ts:28-58`) emits only `health_read_invalid` (`:43`) and `health_failed`
(`:49,:57`), both of which stay.
**Why safe against the one real attack:** `KernelErrorCode` types `KernelError.code`
(`server/src/kernel/boot-channel.ts:9`), and the only place a code crosses a wire into that type is
`boot-channel.ts:96-145`, where every branch decodes against an explicit literal list — no health code
among them. Extension routes take `payload: Schema.JsonObject` (`kernel/ext.ts:42`) and never construct a
`KernelError` with an arbitrary code. These codes are members of the union `errorSchemas` turns into wire
schemas, which appears in persisted places (idempotency outcomes, event payloads) — but a code that was
never constructed was never persisted, so there is nothing to decode.
**Effect:** four members leave the 48-member `errorSchemas` union at `errors.ts:252` that all 16
`HttpApiEndpoint` declarations and 5 extension routes pass as `error: errorSchemas`, so four unreachable
500 responses stop being advertised in the OpenAPI document at `GET /api`.
**Land the spec reconciliation in the same change.** These are orphans of a probe that was deliberately
narrowed — `docs/pr-1/second-pass-5d96c1d.md:752` and `fourth-pass-efa6de5.md:119` record that `health.ts`
used to POST `/api/messages` and GET `/api/messages` and `/api/topics/<path>` and fail
`health_route_failed`/`health_create_invalid`, and that commit `86ce97b` replaced it with the kv probe.
**`SPEC.md:509` still mandates the old probe word for word** ("invoke the actual assembled
`POST /api/messages`, `GET /api/messages` and `GET /api/topics/<path>` handlers … A missing, broken or
overridden route must fail health"). Deleting these codes erases the last in-code trace that §7.4 is
unimplemented. Either amend `SPEC.md:509` to describe the kv probe, or restore the probe — and if the
probe is restored, `health_route_failed` and `health_create_invalid` come back with it.
**Guarantee:** 2 (a broken generation never becomes live) is *already* weaker than SPEC.md:509 describes,
independently of this cut. Do not let this step disguise that.
**How to tell:** typecheck passes (the compile-error rule at SPEC §12 would catch a removed-but-used
literal); the OpenAPI snapshot at `GET /api` diffs by exactly four union members.

### Step 5c — Two dead wire literals in boot's refusal boundaries (2 lines, boot)

```
packages/boot/src/database-restore-http.ts:82  "generation_not_found" — not a member of AuthError["code"], appears nowhere else in the repo
packages/boot/src/backup-http.ts:137          code: "backup_failed" — exists in no policy table, no schema, no fixture, no test
```
`backup_failed` is an undocumented wire code invented at one call site. (The same string in
`docs/database.md:375` is an unrelated `DbOpsError` from the storage package — a name collision, which is
its own argument for not minting codes outside the tables.) Replace `backup_failed` with a code that has a
policy entry, or add its entry; delete the `generation_not_found` literal from the `.includes([...])` test.
**Guarantee:** none. **How to tell:** `grep -rn 'backup_failed\|generation_not_found' packages` returns nothing
outside a policy table.
This is 2 lines. It is here because it is the cheapest correct thing in the audit and because leaving a
wire code with no schema entry is how the next reviewer justifies a fifth hint table.

### Step 6 — Legacy store adoption (45 lines, boot) [B-6, corrected]

```
packages/boot/src/legacy-topic-moves.ts                    7   whole file
packages/boot/src/app-store-identity.ts:101-117, :133    ~25   the mode:'legacy' branches and the legacy_store_id backfill
packages/boot/src/backup-inventory.ts:29-36              ~12   the provenance field
packages/boot/src/boot-schema.ts:222-223                        the `version < 16 && hasLegacyTopicMoves` rung
packages/boot/src/index.ts:3                                    the wiring
```
**Behaviour lost:** a volume laid out by an earlier build — `comms.db` at the data root, or carrying
`topic_moves`/`topic_page_moves` tables — is no longer adopted automatically. Boot refuses to start
against it instead of migrating it. Backups no longer carry a `provenance` field distinguishing
`legacy_adoption` from `not_recorded`.
**Why acceptable:** chirp has never shipped. `legacy-topic-moves.ts:4` reads "Presence alone requires the
previous compatible image; never interpret or retire historical evidence" — about a feature the owner
removed on 2026-09-10 and which `SPEC.md:696` records as out of boot. This is one of 98
legacy/retired/deprecated references in a product with no history to be compatible with.

**DO NOT delete `packages/boot/src/app-store-layout.ts` (118).** The original proposal targeted the whole
file at 118 lines; the defence proved four blocks of it are live durability machinery on the *current*
layout, and the corrected cut is 45 lines, not 118:

- `:26-27` refuses any filename that is not `<root>/store/comms.db`
- `:30-31` realPath-checks the `store/` directory against a symlink swap
- `:37-46` `regular()` uses `readDirectory` specifically so a **dangling symlink is detected rather than
  treated as missing** (the comment at `:36` says so)
- `:66-75` refuses to proceed when a `-wal`, `-shm` or `-journal` sidecar exists without its main database.
  **This is the important one.** An orphan `-wal` beside a missing or replaced `comms.db` is exactly the
  state left by a botched restore, and opening SQLite against it silently loses or misapplies committed
  transactions.
- `:59-65` `opaqueRollback` is the single exemption permitting an in-flight offline restore rollback. It
  exists because of `restore-before-image.ts`, which was defended and stays. Removing it breaks rollback.

Also leave `app-store-layout.ts:110-113` (the re-chown/re-chmod to `0o660`) alone for now: it looks
redundant with `linux-ownership.ts:115-121`, but `app-store-layout` derives the gid from the store
directory while `linux-ownership` hardcodes 1001:1003, so they are only equivalent inside the container.

**Guarantee:** 1 and 3. **Condition (Step 0 q2):** `ls /data/comms.db` on the box; if it exists, `mv` it
under `store/` before deploying the cut.
**How to tell:** boot starts clean against a fresh volume and against a current-layout volume; boot
**refuses** (rather than migrates) against a hand-made data-root `comms.db`; the orphan-sidecar refusal
still fires — create `store/comms.db-wal` with no `store/comms.db` and confirm boot refuses to start.
Update `boot/test/app-store-layout.test.ts`, `boot/test/combined-restore-migration.test.ts` and the legacy
arms of `boot/test/app-store-identity.test.ts` — **update, do not delete wholesale**; the layout tests
cover the four live blocks above.

### Step 5d — `child_attempts.opened` (6 production lines, 42 with tests) [O-4]

```
packages/boot/src/child-attempts.ts:34    the opened() method
packages/boot/src/child-attempts.ts:37    its stale comment
packages/boot/src/supervisor.ts:299       call site
packages/boot/src/cutover.ts:336          call site
packages/boot/src/database-restore.ts:164 call site
packages/boot/src/boot-schema-shape.ts:10 the shape assertion
```
`reserve` already inserts `opened=1` unconditionally (`child-attempts.ts:31`); `opened()` sets it to 1
again; `recover` selects `WHERE closed=0` and never reads the column (`:38-46`). The comment at `:37` —
"Older versions marked opened only after imports" — records that the question it answered was folded into
the reservation itself.
**Do NOT edit migration 9's `CREATE TABLE` at `boot-schema.ts:116`, and do not drop the column.** The repo
treats shipped migration bodies as pinned history: `packages/boot/test/fixtures/boot-schema-history/v16.sql:12`
and `v18.sql:12` both carry `opened`, exported from real historical commits, and
`boot-schema-history.test.ts` adopts them against today's initializer. Editing a shipped migration to save
one line is the only risky part of this cut.
**Guarantee:** 1. **How to tell:** `grep -rn 'opened' packages/boot` returns only migration 9's DDL and the
history fixtures; `boot-schema-history.test.ts` passes unchanged.
**Honest note:** 6 production lines out of 13,536 is below the noise floor. It is in the plan because it
is free and because it is the cleanest single illustration of the pattern — ownership evidence kept after
the question it answered moved into the reservation.

---

## 6. Test cost

Kept separate because it changes no behaviour. Total **1,206 test lines**, of which 946 are consequences
of Steps 3 and 4 and 260 are independent. The 231 lines of CI workflow, acceptance script and vendor
patch that go with Step 3 are counted separately again — they are neither production nor test.

| item | lines | when |
|---|---|---|
| remote-engine test suites and fixtures (Step 3) | 786 | with Step 3 |
| `dialect.test.ts` three-dialect matrix → sqlite (Step 4c) | ~100 | with Step 4 |
| remote arms of `store.test.ts` (Step 4a) | ~60 | with Step 4 |
| **T-6** execFile preamble consolidation | **224** | any time |
| `child_attempts.opened` assertions (Step 5d) | 36 | with Step 5d |

### Step 8 — T-6: one `runFixture` helper (net 224 lines)

**41** test files whose every `expect` is a `toContain` on a spawned fixture's stdout, totalling **836**
lines (the original proposal said 47 files / 1,347 lines and double-counted
`packages/server/test/http-contract.test.ts` (152) with another proposal; that file is not a token-only
test). Removing the ~6-line preamble from each — `import { execFile } from "node:child_process"`,
`import { promisify } from "node:util"`, `import { mkdtemp, rm } from "node:fs/promises"`,
`import { tmpdir } from "node:os"`, `const execute = promisify(execFile)`, the `test.onTestFinished`
cleanup — and adding one ~22-line `fixtures/run.ts` nets **224**.

**Why this is safe where a shared stub would not be:** the fixtures keep their own assertions (16 of 17
import `node:assert/strict`) and `execFile` rejects on a non-zero exit, so a shared `runFixture` cannot
mask a failing fixture.
**Two implementation constraints.** Keep the per-file `it.for` mode tables where they are — they name the
scenarios and belong next to the title, not in the helper. And `packages/boot/test/settings.test.ts:20-32`
runs two fixture invocations (`persist` then `resume`) against the **same** temp directory deliberately, so
the helper must let the caller own the directory across calls rather than minting one per run.
**How to tell:** the full suite passes with identical pass/fail counts before and after; deliberately break
one fixture's assertion and confirm its test still fails.

---

## 7. What was defended, and why — do not relitigate

Fifty-seven proposals were argued and rejected. This is the record of which machinery is genuinely
load-bearing. Each entry is a cut that looked obviously right and was not.

**B-1 — delete the per-code hint strings and the five HTTP error boundaries (420 lines).** Four separate
defences, each independently fatal.
(a) `SPEC.md:697` is the decided design, not accretion: "one record per module maps code to status and to
a hint that says what to do next, so a code without a mapping is a compile error."
(b) The claim "callers still get the same `retriable` flag" is **false**. The replacement must derive
`retriable`, and the only plausible derivation is `status === 503`. `edit-failure.ts:74-78`
`accepted_cleanup_pending` is **503 with `retriable: false`** — deliberately. It is raised at `cutover.ts:157`
after a cutover has been *accepted* (generation live, writes preserved) when boot's own metadata cleanup
failed; its hint says "Do not repeat the reload or restore the database; accepted writes are preserved."
A mechanical collapse flips this to `retriable: true` and invites an agent retry loop to re-run cutover
against an accepted generation with unknown metadata. **No test covers this entry, so the flip would ship
silently.**
(c) `store-identity-diagnostics.ts` (18) is not a hint table. `safeStoreId` is the only sanitizer on
`store_id` values read out of an **untrusted app database that just failed identity verification**
(`app-store-identity.ts:174`) and on `legacy_store_id` echoed by `backup-inventory.ts:34,47`.
(d) The two "hand-rolled repeats" are deliberate per-route overrides. `backup-http.ts:85-90` forces
`retriable: false` for every `ChildError`, commented "Capture may have committed before resuming its child
failed. Never invite an automatic second copy" — this is what stops a retry loop filling the volume with
duplicate backups. `database-restore-http.ts:67-80` gives `external_conflict` a restore-specific meaning.
Further: `event-http.ts:108-134` `eventStatus` is `Record<code, [number, number]>` keyed by route mode —
`credential_expired` is 401 on one and 409 on the other, `events_unavailable` 503 vs 409, `stale_attempt`
403 vs 409. A flat `Record<code,status>` cannot express it. And the key sets act as an **allowlist**:
`boot/test/fixtures/http-error-contracts.ts:44-45,106,123-130` proves an error whose code is not a key
must fall to `handler_failed` 500 with none of the secret strings in the body.
**Residual, if the owner wants it:** delete the *prose only*, ~170 lines, keeping all four tables' keys,
statuses, `retriable` values, `store-identity-diagnostics.ts` and the two route overrides. Not in this plan.

**B-2 — delete `route-discovery.ts` (254 lines).** The manifest's `endpoints` and
`components.securitySchemes` — exactly the two fields the cut removes — are consumed by the app.
`server/src/discovery.ts:6-9` decodes the response against a schema requiring both, and `:20-27` merges
them into the app's own OpenAPI document; on decode failure `:30` yields `KernelError{boot_unavailable}`,
so **the app's entire `/api` document breaks**, not just discovery. The manifest is also a security
exclusion list — `route-discovery.ts:4` "Private child IPC is intentionally excluded", with
`boot/test/route-discovery.test.ts:20-22` asserting `/_boot/seq`, `/_boot/events/append` and
`/api/messages` are undefined. `server/src/api-security.ts:6-8`: "a client generated from `\"security\": []`
ships with no credentials and fails on first contact." `SPEC.md:695` decides it: "The machine manifest
carries boot's routes too." The route *descriptions* are prose and could be shortened; the structure cannot go.

**B-3 — delete the signed settings store (265 lines).** `settings-schema.ts` (116) cannot be deleted:
`readStoragePolicy` (`:107-115`) has three consumers the proposal keeps — `storage-headroom.ts:4,20`
(the §7.5 5% refusal), `artifact-retention.ts:3,75`, `event-storage.ts:3,108,160` — and `SettingsChange`
/ `canonicalSettings` are imported by `auth.ts:2` and `enrollment-http.ts:2`. Critically,
`validPublicPath` (`:15-34`) is a **deny-list, not a formatter**: it refuses `/_boot`, `/_kernel`, `/auth`,
`/approve`, `/setup`, `/p`, `/api/fs`, `/api/lock`, `/api/reload`, `/api/revert`, `/api/generations`,
`/api/events`, `/api/tokens`. It stops anyone holding a human session from marking `/api/fs` or `/auth`
unauthenticated. The proposal's own fallback — "keep a 15-line unsigned POST behind the human session" —
keeps the write path and drops the validator, which is strictly worse than either alternative.
`SPEC.md:161` puts the allowlist in settings by name.
**Residual:** `settings.ts` (126) + `settings-http.ts` (26) + descriptors ≈ 165 lines, conditional on the
owner amending SPEC §4.3 and on keeping `settings-schema.ts` with its three consumers rewired to frozen
constants. Not in this plan.

**B-4 — delete `restore-before-image.ts`, "the second rollback copy" (200 lines).** The two mechanisms are
not alternatives; they cover disjoint cases and produce **different outcomes**. `database-restore.ts:120`
requires at least one to exist; that is a completeness check across two mutually exclusive branches, not
"either is sufficient". `:127-136` (before-image present) rolls back, writes
`failure='offline_restore_not_accepted'` and `supervisor.fail(ChildError{restore_recovery_required})` —
boot deliberately **stops without a child** for human inspection. `:138-142` (safety backup) restores,
calls `recovery.prepare(freshEpoch)` and continues serving. Different failure semantics.
The hashed manifest is not decoration around a rename: `:132-138` verifies every file's length and
SHA-256 before touching even a live sidecar, and `:140-152` does the part a rename cannot — it stages each
protected file under a fixed sibling name, fsyncs, renames, and then reconciles the **sidecar set** to
exactly what was captured (`for (const suffix of suffixes) { if (in manifest) rename; else remove }`).
A plain `mv comms.db.before-<proof> comms.db` leaves the failed restore's `-wal` next to the restored main
file; SQLite then opens an old database with a foreign write-ahead log. That is silent corruption, not a
visible failure — **the exact way you lose a customer's data**. The proposal's replacement did not mention
sidecars at all.

**B-5 — merge the three keepers into one (186 lines).** This is a refactor, not a deletion, and the three
entry points are three **privilege domains**. `child-process.ts:65-66` spawns
`sudo -n /opt/comms/deployment/child-keeper`; `preparation-process.ts:41` spawns
`sudo -n /opt/comms/deployment/preparation-keeper` — two distinct sudoers entries. The child keeper drops
to `--reuid=1001 --regid=1003`, the preparation keeper to `--reuid=1002 --regid=1002`
(`linux-ownership.ts:8-25`). One merged binary means one sudoers path serving both, and the sudoers file
can no longer distinguish "run the board" from "run npm install". `sqlite-copy-process.ts:137` spawns its
keeper with **no sudo and no setpriv at all**, and `sqlite-copy-configuration.ts:3` states why: "Fixed
immutable copy operation; no command, module or credential is supplied." Its schema has only `attempt`,
`source`, `destination`, `receipt`, `budgetMs`, whereas `keeper-configuration.ts:4-10` has `entry`, `cwd`,
`env` — by construction an arbitrary-exec contract. A tagged-union config makes the tag the only thing
between a copy request and arbitrary execution, inside the one file an agent cannot repair.
The cited divergences are design, not drift: the 50-iteration poll in `sqlite-copy-keeper.ts:64` follows an
**extra group `SIGKILL` at `:57-62`** the other two do not perform, and `Effect.orDie` vs typed `ChildError`
is deliberate — `preparation-keeper.ts:86` types the error because preparation failures are reported to the
editing agent as something it can fix (SPEC.md:697), while a child-keeper closure failure is a boot-level
defect that must die.

**Also defended and not in this plan** (summarised): B-7 (event byte-budget caps — `SPEC.md:552`'s
"`/_boot/status` shows usage against each budget" is in the same sentence as the caps); B-9 (the
sqlite-copy intent journal — its proposed safe fallback is the boot-id check, which `SPEC.md:696` lists
under **Stays**); B-10 (schema shape probes); E-1 (merge the refusal boundaries — see B-1(b)(d));
D-8 (`transferred_to`, which is the completion marker `SPEC.md:689` names and which dies with Step 1's
spec edit rather than on its own).

**The pattern in the rejections.** Three recurring errors, worth naming because the next audit will make
them again:
1. **Validators read as prose.** `safeStoreId`, `validPublicPath`, `request_actor`,
   `app-store-layout.ts:37-46,66-75` were each presented as documentation or a case split that never
   varies. Each is the only enforcement point for something.
2. **The spec read selectively.** Three cuts collided head-on with decided lines in the document they
   cited — `SPEC.md:697`, `SPEC.md:552`, `SPEC.md:696`. (B-8 is the honourable exception: `SPEC.md:702`
   genuinely retired the type/topic/agent/instance filters from boot and the code did not follow. ~80 lines,
   not carried here because it was only partly defended and needs a second round.)
3. **Refactors dressed as deletions.** B-5 and the closure-protocol extraction remove no behaviour.

---

## 8. The cuts nobody proposed

From the defenders' "missed" reports. **None of these has been through a defence round.** Argue each one
before executing it; that is how everything in §7 was caught.

1. **Boot's account and credential surface — ~366 lines, of which ~125 are confidently cuttable.**
   Promoted into this plan as Step 7 (§4). The remaining ~240 (passkey add/delete) blocks on the owner
   answering how a human recovers a lost sole passkey.
2. **The db-doc review corpus — 2,168 doc lines.** `docs/pr-1/db-doc-review-a.md` (1,579),
   `db-doc-review-b.md` (459), `db-doc-verification.md` (130). D-7 explicitly kept these ("they record what
   happened, they do not authorise anything"), which is backwards for this corpus: they are not the review
   history of shipped code, they are 2,168 lines of findings against `docs/database.md` — a design document
   for a track that produced no production module and which Step 2 deletes. **Step 9: delete them with
   Step 2, or immediately after.** Zero risk, zero code, largest single line count in the plan.
3. **The five refusal boundaries, not three — `backup-http.ts:55-146` (92) and
   `database-restore-http.ts:49-88` (40), ~110 net after adding two table entries.** Both are hand-rolled
   `Effect.catchCause` blocks that build envelopes inline instead of calling `errorResponse`.
   `backup-http.ts:121-125` is a **third and fourth** copy of the storage hints already in
   `edit-failure.ts:97-113` and `event-http.ts:63-67`, with the status re-derived by an inline ternary at
   `:129` reproducing `edit-failure.ts`'s table values by hand. `database-restore-http.ts:82-86` restates
   statuses the auth table already holds (`backup_not_found` 404 at `auth-http.ts:53`, `backup_not_restorable`
   409 at `:54-57`, `generation_not_restorable` 409 at `:72-75`, `restore_in_progress` 409 at `:94-97`).
   **This partly contradicts B-1's defence** (which argued both blocks are deliberate overrides). Both can be
   true — the overrides at `backup-http.ts:102-105,140-143` (`retriable: false` at 503, justified at `:94`)
   and the "A copy may already exist; inspect `/_boot/db/backups` before another capture" suffix must survive
   as two table entries plus one suffix parameter on `errorResponse`. **Do not execute without a defence
   round**, and note it corrects B-1 twice over: the merge is of five boundaries, not three, and
   `retriable = status === 503` has at least three exceptions, not one — the two extra being exactly where
   an automatic retry takes a second backup.
4. **The closure-protocol extraction — ~100 boot lines, refactor not deletion.** See §3.
5. **`app-store-layout.ts:110-113`** re-chowns and re-chmods the live store to `0o660`, which
   `linux-ownership.ts:115-121` already does on every launch — ~4 lines, genuinely redundant only inside the
   container. Lowest-confidence item in the audit; listed for completeness.

---

## 9. The step that actually keeps boot small

No deletion in this plan prevents the next 4,000 lines. The old audit's cuts were all taken and boot
doubled anyway. What would have stopped every item in §5 and §7 is a **merge-time test**, and it was
already written down and never automated:

> *If this were wrong, could an agent fix it over HTTP, and would a broken version stop an agent editing,
> authenticating, or keeping its data?*

Every cut above fails that test, and every one of them shipped. The second half of the fix is a review
convention: **a finding about a missing guarantee must first be answered by naming the existing mechanism
that covers it, and may add a new mechanism only when no existing one does.** Sixty-six findings across the
database stack were closed by adding a mechanism; that habit, not any file, is what produced nine answers
to one question about whether a process is dead.

---

## Execution order at a glance

| # | step | prod | test | docs | gate |
|---|---|---|---|---|---|
| 0 | owner decisions (3 questions) | — | — | — | — |
| 1 | strike the SPEC sentences + `.env.example` | — | — | — | owner |
| 2 | delete `docs/database.md`, `database-interoperability.md` | — | — | 1,851 | Step 1 |
| 9 | delete the db-doc review corpus | — | — | 2,168 | Step 2 |
| 3 | delete the remote client stack, tests, CI, patch | 419 | 786 | — | Step 1 | (+231 CI/script/patch)
| 4 | collapse the engine seam (store.ts, boot-write-lock, dialect arms, engine columns) | 211 | 160 | — | Step 3 |
| 5a | `shipped_at` + second outbox loop | 22 | — | — | Step 0 q3 |
| 5b | four dead health error codes (+ SPEC.md:509 reconciliation) | 24 | — | — | owner |
| 5c | two dead wire literals | 2 | — | — | — |
| 6 | legacy store adoption (NOT `app-store-layout.ts`) | 45 | update | — | Step 0 q2 |
| 5d | `child_attempts.opened` (NOT migration 9) | 6 | 36 | — | — |
| 7 | boot account/token listings → app | 125 moved | — | — | app route lands first |
| 8 | T-6 `runFixture` helper | — | 224 | — | — |
| | **total** | **729 + 125 moved** | **1,206** | **4,019** | +231 CI/patch |
