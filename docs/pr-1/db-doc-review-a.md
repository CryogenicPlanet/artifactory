# Adversarial review A of `docs/database.md`: API and SQL correctness

Lens: correctness of every technical claim — Effect v4 API names and signatures, adapter
configuration, SQL dialect semantics, and what the current code actually does. Durability and
operations are reviewer B's.

Evidence base: the vendored Effect v4 rc at `repos/effect/` (`@effect/sql-*` at
`4.0.0-rc.113`) and the working tree at `6c21a88` (`git log --oneline -1`).

**The document moved under review.** When I started it was 1014 lines with MySQL "designed for,
not shipped"; it is now 1203 lines with MySQL shipping, a new section 15, and sections 15/16
renumbered to 16/17. All line numbers below are against the 1203-line version. Findings 1, 2, 5,
6 were re-checked against the new text and still apply; the collation gap I had as a top finding
was closed by the new §3.3 and is listed under "could not refute".

Findings 1 to 34 are the first pass. **Findings 35 to 43 are a second pass** over the material
that is new or rewritten in the 1203-line version: §2's R4/R4a/R4b, §3.3's MySQL grant script,
§8.2 to §8.4's tokeniser claims, §12.2 and §12.3, §13 steps 6 and 8, §14.4, and the new §15.
They are numbered after the first pass so earlier cross-references stay valid; severity is marked
on each and the index below is ordered by severity across both passes.

Severity key: **BREAK** = wrong and would break at runtime or fail to compile;
**WRONG** = factually false but the surrounding recommendation survives;
**IMPRECISE** = citation or count off; **UNVERIFIABLE** = could not confirm from source.

### Index by severity

**BREAK (10):** 1 Postgres roles lack `CREATEDB` · 35 `mysqldump` needs global `PROCESS` ·
2 `Migrator` inside an outer pg transaction · 3 untyped null parameters · 4 `substr(value,-1)` ·
5 MySQL affected-rows fence · 36 MySQL boolean mode defaults to OR · 6 MySQL
`SET TRANSACTION READ ONLY` · 7 two `MAX(a,b)` sites · 8 §3.4 has no mechanism

**WRONG (9):** 9 two-arg `MAX` is a hard error · 10 the rehearsal-copy timeout · 11
`latestMigration` is not exported · 12 `PgMigrator` credentials · 13 `MysqlClient.layer` error
type · 14 `FROM topics` sites · 37 InnoDB stopwords · 38 `websearch_to_tsquery` operators ·
39 §15.1's table inventory

**IMPRECISE (22):** 15 to 33, 40, 41, 42 · **UNVERIFIABLE (2):** 34, 43

---

## 1. BREAK — the Postgres grant script denies `comms_boot` the `CREATEDB` that every clone, drill and restore needs

**Doc line 92** (and 94):

> `CREATE ROLE comms_boot LOGIN PASSWORD :'boot_password'`
> `  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`

**Doc line 118:**

> **The app role must not be `SUPERUSER` and must not have `CREATEDB`.** … `NOSUPERUSER NOCREATEDB` is the load-bearing half of the whole boundary.

**What is actually true.** Three `DbOps` methods and one procedure step require `CREATE DATABASE`
or `DROP DATABASE` on Postgres, and the script grants neither role the privilege to do it:

- line 360, `cloneForRehearsal`: `CREATE DATABASE comms_rehearsal_<label> OWNER comms_boot`
- line 362, `restoreInto`: `CREATE DATABASE comms_app_<n> OWNER comms_app`
- line 363, `dropClone`: `DROP DATABASE <clone>`
- line 364, `reapClones`: "drop those not referenced by a live record"

A `NOCREATEDB` role gets `ERROR: permission denied to create database` (42501) on every one of
them. The prose at line 118 argues only about the *app* role, but the script at line 92 applies
the same flags to `comms_boot`, so there is no role in the deployment that can create a scratch
database. Rehearsal, the drill, restore and the reaper are all dead on Postgres.

The MySQL script gets this right and makes the omission obvious by contrast: lines 162 to 164
grant `comms_boot` the scratch-database name patterns explicitly. The Postgres script has no
equivalent.

Two further Postgres-specific consequences of the same role design:

- `CREATE DATABASE comms_app_<n> OWNER comms_app` (line 362) run by `comms_boot` requires
  `comms_boot` to be a member of `comms_app` even once it has `CREATEDB`; a non-superuser may
  only create a database owned by a role it belongs to.
- Line 795's `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '<old>'`
  needs superuser or `pg_signal_backend` membership to signal another role's backends.
  `NOSUPERUSER` with no role grant cannot do it, so the "belt-and-braces second check" silently
  returns no rows rather than terminating anything.

**Replacement text**, for lines 91 to 94 and the note at 118:

```sql
CREATE ROLE comms_boot LOGIN PASSWORD :'boot_password'
  NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE comms_app  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT comms_app TO comms_boot;   -- so comms_boot may CREATE DATABASE ... OWNER comms_app
GRANT pg_signal_backend TO comms_boot;  -- for the pg_terminate_backend second check
```

and for line 118:

> **The app role must not be `SUPERUSER` and must not have `CREATEDB`.** … `NOSUPERUSER
> NOCREATEDB` on `comms_app` is the load-bearing half of the whole boundary. The boot role is the
> asymmetric half: it needs `CREATEDB` because `cloneForRehearsal`, `restoreInto`, `dropClone`
> and `reapClones` all create or drop scratch databases, membership in `comms_app` so it can
> create a database owned by the app role, and `pg_signal_backend` for the termination check in
> section 10.3. Postgres has no way to scope `CREATEDB` to a name pattern the way the MySQL
> script does at `comms_rehearsal\_%`, so the boot role's database-creation right is unscoped and
> the boundary rests on the app role not having it.

---

## 2. BREAK — nesting `Migrator` inside comms' outer transaction aborts that transaction on Postgres

**Doc line 537:**

> It wraps its `run` in its own `sql.withTransaction` at `:308`, and `packages/server/src/kernel/migrations.ts:45` already wraps that in an outer transaction. The inner therefore becomes a savepoint (`SqlClient.ts:294`). That nesting is intentional, because the outer transaction is what holds the epoch gate at `migrations.ts:47`, and it should stay.

**What is actually true.** The nesting is fine on SQLite and breaks on Postgres, for a reason the
doc does not mention. `Migrator` runs `ensureMigrationsTable` at `Migrator.ts:305`, *outside* its
own `withTransaction` at `:308` but inside comms' outer transaction. On Postgres that function is
(`Migrator.ts:135-144`):

```ts
pg: () =>
  Effect.catch(
    sql`select ${table}::regclass`,
    () => sql`CREATE TABLE ${sql(table)} (...)`
  ),
```

On a store that does not yet have the ledger, `select 'migrations'::regclass` raises `42P01`.
Inside an open Postgres transaction any error aborts the whole transaction, and every subsequent
statement fails with `25P02 current transaction is aborted, commands ignored until end of
transaction block`. The `CREATE TABLE` in the `Effect.catch` handler is exactly such a subsequent
statement, so it fails too, and so does everything after it including the epoch gate's
transaction. Effect's pg client issues no implicit per-statement savepoint (`SqlClient.ts:294` is
the only savepoint site, and it fires only for a nested `withTransaction`), so nothing rescues it.

This is not hypothetical: it is the first migration run on every fresh Postgres app store.

The doc found the MySQL half of this hazard (§14.4 item 1, line 1044, on `Migrator.ts:264`
inserting the ledger rows before `:276` runs the effects) and missed the Postgres half.

**Replacement text** for line 537:

> It wraps its `run` in its own `sql.withTransaction` at `:308`, and
> `packages/server/src/kernel/migrations.ts:45` already wraps that in an outer transaction. The
> inner therefore becomes a savepoint (`SqlClient.ts:294`), which is what keeps the epoch gate at
> `migrations.ts:47` atomic with the migrations it guards on SQLite and Postgres.
>
> One Postgres hazard comes with that nesting. `ensureMigrationsTable` runs at `Migrator.ts:305`,
> outside the migrator's own transaction but inside comms', and its pg branch probes
> `select <table>::regclass` and creates the table in an `Effect.catch` (`Migrator.ts:135-144`).
> On a fresh store that probe raises `42P01`, which aborts the enclosing Postgres transaction, and
> the `CREATE TABLE` in the handler then fails with `25P02`. comms must therefore create the
> ledger itself before opening the outer transaction — `CREATE TABLE IF NOT EXISTS` with the same
> column list as `Migrator.ts:139-143` — so that by the time the migrator runs,
> `ensureMigrationsTable`'s probe succeeds and never raises. The adopt step in section 7.3 already
> needs the ledger to exist first, so this is one mechanism, not two.

---

## 3. BREAK — `${x ?? null} IS NULL` binds an untyped parameter and fails on Postgres at 13 sites

**Not stated anywhere in the doc.** Section 6 enumerates the statements whose *text* differs per
engine and never mentions parameter typing.

**What is actually true.** The codebase's standard optional-filter idiom binds `null` and then
tests it:

```
packages/boot/src/events.ts:216   AND (${input.topic ?? null} IS NULL OR topic=${input.topic ?? null} OR substr(...))
packages/server/src/kernel/messages.ts:281   AND (${input.exclude ?? null} IS NULL OR instance<>${input.exclude ?? null})
```

There are 13 such sites, in `packages/boot/src/account-queries.ts`,
`packages/boot/src/backup-inventory.ts`, `packages/boot/src/events.ts` and
`packages/server/src/kernel/messages.ts`
(`grep -rn '} IS NULL OR' packages/boot/src packages/server/src`).

The Effect pg adapter binds `null` with type OID `0`, meaning unspecified
(`repos/effect/packages/sql/pg/src/PgConnection.ts:790`: `if (value === null || value ===
undefined) return inferredParameter(0, null)`), and it binds strings the same way, deliberately
(`:806-810`). Those OIDs go straight into the `Parse` message (`PgConnection.ts:990`,
`:949-952`). Postgres cannot infer a type for a parameter whose only context is `$1 IS NULL`, so
it answers `42P18 could not determine data type of parameter $1` at parse time. Every one of the
13 sites is a hard failure on Postgres and on pglite.

MySQL is unaffected: `?` is substituted as a typed value and `? IS NULL` is legal.

**Replacement text**, as a new subsection after §6.7:

> ### 6.7a `nullable(sql, value)` — 13 sites
>
> The optional-filter idiom `(${x ?? null} IS NULL OR col=${x ?? null})` appears 13 times across
> `events.ts`, `messages.ts`, `account-queries.ts` and `backup-inventory.ts`. It works on SQLite
> and MySQL and fails to parse on Postgres. The pg adapter binds both `null` and strings with type
> OID `0`, meaning "let the backend infer"
> (`repos/effect/packages/sql/pg/src/PgConnection.ts:790`, `:806-810`), and `$1 IS NULL` gives the
> backend nothing to infer from, so Postgres answers `42P18 could not determine data type of
> parameter $1`.
>
> | Engine | Emits |
> | --- | --- |
> | sqlite | `${value}` |
> | pg | `${value}::text` (or the column's type) |
> | mysql | `${value}` |
>
> Every bound value that appears in a type-free position — `IS NULL`, `IS NOT DISTINCT FROM`, the
> bare side of a `CASE`, an argument to a polymorphic function — needs the cast on Postgres. This
> is the second silent-on-SQLite, loud-on-Postgres class after the `int8` codec in section 7.5,
> and unlike that one it fails at parse time, so the pglite suite catches all 13 at once.

---

## 4. BREAK — `substr(value,-1)` means something different on Postgres and silently disables wildcard event-type filters

**Not stated anywhere in the doc.** §6.2 treats all 49 `substr(` occurrences as instances of the
`isDescendant` prefix match.

**What is actually true.** `packages/boot/src/events.ts:222` is not a prefix match:

```sql
AND (${types.length}=0 OR EXISTS(SELECT 1 FROM json_each(${typesJson})
  WHERE value=json_extract(event,'$.type')
     OR substr(value,-1)='*'
    AND substr(json_extract(event,'$.type'),1,length(value)-1)=substr(value,1,length(value)-1)))
```

`substr(value,-1)` is the wildcard test: it asks whether the caller's type filter ends in `*`.

- SQLite: a negative start counts from the end, so `substr('message.*',-1)` is `'*'`. Test passes.
- MySQL: `SUBSTR(str,-1)` likewise counts from the end. Test passes.
- Postgres: `substr(string, from)` clamps a start below 1 to 1, so `substr('message.*',-1)` is
  the whole string `'message.*'`. The test `'message.*' = '*'` is false, always.

So on Postgres every wildcard event-type filter stops matching. Nothing errors; `/_boot/events`
just returns fewer events. That is the exact failure shape the doc singles out as the worst in
the whole list when it discusses `distinctFrom` at line 474, and this site is not on any list.

This is the only negative-offset `substr` in the tree
(`grep -rn 'substr([^,]*,-' packages/boot/src packages/server/src`), so it is one site, but it is
invisible in the `substr(` count that §6.2 leans on.

**Replacement text**, as a new subsection after §6.2:

> ### 6.2a `endsWith(sql, value, suffix)` — 1 site
>
> | Engine | Emits |
> | --- | --- |
> | sqlite | `substr(${value},-length(${suffix}))=${suffix}` |
> | pg | `right(${value}, length(${suffix}))=${suffix}` |
> | mysql | `substr(${value},-char_length(${suffix}))=${suffix}` |
>
> The site is `packages/boot/src/events.ts:222`, the `substr(value,-1)='*'` wildcard test in the
> `/_boot/events` type filter. A negative start counts from the end of the string on SQLite and
> MySQL; Postgres clamps any start below 1 to 1 and returns the whole string, so
> `substr('message.*',-1)` is `'message.*'` there and the wildcard test is false for every input.
> Nothing errors: wildcard type filters simply stop matching on Postgres, which is the same silent
> event-dropping failure `distinctFrom` (section 6.7) guards against. It needs the same
> generated-SQL test per dialect.

---

## 5. BREAK — the MySQL fence replacement reads affected rows, and MySQL reports zero for a no-op update

**Doc line 482**, the `RETURNING` substitution table:

> | `packages/server/src/kernel/database.ts:7` | `UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=? RETURNING epoch` | `UPDATE`, check affected rows, then `SELECT epoch FROM kernel_writer WHERE singleton=1` |

and **doc line 715:**

> Two live writers serialize on that row; the stale one sees zero affected rows and fails `stale_writer`.

**What is actually true.** The live statement is verified at
`packages/server/src/kernel/database.ts:7`, and it is a deliberate no-op update: `SET
epoch=epoch`. MySQL's default affected-rows semantics count rows *changed*, not rows *matched* —
an `UPDATE` that sets a column to the value it already holds reports `Rows matched: 1, Changed:
0` and returns `affectedRows = 0` unless the connection was opened with `CLIENT_FOUND_ROWS`. So
on MySQL the healthy writer sees zero affected rows on every mutation and reports `stale_writer`,
and the board takes no writes at all.

`MysqlClientConfig` (`repos/effect/packages/sql/mysql2/src/MysqlClient.ts:182-209`) has no
`foundRows` field; the only way in is `poolConfig?: Mysql.PoolOptions` at `:197`, which does
carry mysql2's `flags` / `foundRows`.

Postgres is unaffected because it keeps `RETURNING` and the code counts returned rows
(`database.ts:8`, `rows.length !== 1`), and because a no-op update there still writes a new row
version, exactly as line 717 says.

**Replacement text** for the table row at line 482:

> | `packages/server/src/kernel/database.ts:7` | `UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=? RETURNING epoch` | `SELECT epoch FROM kernel_writer WHERE singleton=1 AND epoch=? FOR UPDATE`, then fail `stale_writer` on zero rows. **Not** `UPDATE` plus affected rows: the statement is a deliberate no-op (`SET epoch=epoch`), and MySQL's affected-rows count reports rows *changed*, so a healthy writer would see `0` and declare itself stale on every mutation. `SELECT … FOR UPDATE` takes the same exclusive row lock and gives an unambiguous row count. If the `UPDATE` shape is kept instead, `MysqlClientConfig.poolConfig` (`MysqlClient.ts:197`) must set mysql2's `foundRows`, and that is a global change to every statement's row count in the process. |

---

## 6. BREAK — `SET TRANSACTION READ ONLY` cannot be issued inside an open MySQL transaction

**Doc line 851** (§11) and **doc line 366** (§5.2):

> | mysql | `SET TRANSACTION READ ONLY` before the statement |
> | `readOnlySession` | … | `sql.withTransaction` with `START TRANSACTION READ ONLY` semantics, expressed as `SET TRANSACTION READ ONLY` before the statement. |

**What is actually true.** In MySQL, `SET TRANSACTION READ ONLY` without `GLOBAL` or `SESSION`
applies to the *next* transaction and must be issued before it starts. Issued inside an active
transaction it raises `ER_CANT_CHANGE_TX_CHARACTERISTICS` (1568), "Transaction characteristics
can't be changed while a transaction is in progress". Both doc rows place it inside the
`sql.withTransaction` that the design already opened, so `readOnlySession` errors on MySQL on
every call.

`SqlClient` gives no hook for this: `beginTransaction` is fixed per client at
`SqlClient.ts:171`, and `withTransaction` takes no options (`SqlClient.ts:57-59`) — which the doc
itself establishes at line 739 for the isolation prelude and then does not apply here.

Postgres is fine: `SET TRANSACTION READ ONLY` is legal inside a transaction as long as no query
has run.

**Replacement text** for the MySQL rows at lines 366 and 851:

> mysql: `SET SESSION TRANSACTION READ ONLY` on the dedicated read-only connection at acquire
> time, then ordinary `sql.withTransaction`. `SET TRANSACTION READ ONLY` without a scope keyword
> applies to the next transaction only and raises `ER_CANT_CHANGE_TX_CHARACTERISTICS` (1568) once
> a transaction is open, and `SqlClient` fixes `beginTransaction` per client
> (`SqlClient.ts:171`) with no per-call options (`:57-59`), so there is no way to get
> `START TRANSACTION READ ONLY` out of `withTransaction`. Session scope on a connection reserved
> for this route is the portable equivalent, and it matches the SQLite mechanism, which is also a
> separate connection rather than a per-transaction flag.

---

## 7. BREAK — there are two two-argument `MAX` sites, not one

**Doc line 36:**

> One site still violates the second: `packages/server/src/kernel/read-marks.ts:72` does `DO UPDATE SET seq=MAX(reads.seq,excluded.seq)`.

**Doc line 470** (§6.6 heading is "— 1 site"):

> The site is `packages/server/src/kernel/read-marks.ts:72`.

**What is actually true.** `grep -rn "MAX([a-zA-Z_.]*,[a-zA-Z_.]*)" packages/boot/src
packages/server/src` returns two:

- `packages/server/src/kernel/read-marks.ts:72`
- `packages/server/src/kernel/topic-move.ts:120` — `INSERT INTO reads(instance,topic,seq) SELECT
  … ON CONFLICT(instance,topic) DO UPDATE SET seq=MAX(reads.seq,excluded.seq)`

The second is the read-mark carry-over during a topic move, and it is the same construct for the
same reason. Missing it means §6.6's "1 site" helper rollout leaves a statement that does not
parse on either remote engine, in a path that only runs during a topic move and so will not be
hit by ordinary smoke testing.

**Replacement text** for line 36's second sentence and for line 470:

> Two sites still violate the second: `packages/server/src/kernel/read-marks.ts:72` and
> `packages/server/src/kernel/topic-move.ts:120`, both `DO UPDATE SET
> seq=MAX(reads.seq,excluded.seq)`. Fix both now.

and the §6.6 heading becomes `### 6.6 greatest(sql, a, b) — 2 sites`.

---

## 8. BREAK — §3.4's two-schema fallback has no mechanism in the vendored adapter

**Doc line 177:**

> Some managed providers hand you exactly one database. In that case boot's role owns schema `boot`, the app's role owns schema `comms`, and every `DbOps` operation gains a schema argument. Keep it behind the same interface so the choice is configuration, not a code path an editing agent has to reason about. This is the only supported deviation from R2, and it is Postgres-only.

**What is actually true.** Two things make this unbuildable as described.

`PgClientConfig` (`repos/effect/packages/sql/pg/src/PgClient.ts:80-123`) has no `searchPath`
field and no connection-initialisation hook. There is no place to issue `SET search_path` once
per pooled connection, and issuing it per statement is not possible either, since statements go
through `sql` templates that the design does not intercept. The URL parser ignores unknown query
parameters (`PgConnection.ts:2281`, "Unknown query parameters are ignored, matching libpq"), so
`?schema=comms` from the §4.1 grammar reaches the server and does nothing.

Separately, "every `DbOps` operation gains a schema argument" does not reach the statements that
need qualifying. `DbOps` owns clone, backup, restore, drop, reap, capacity, `readOnlySession` and
`tableExists` — none of which name an app table. The 408 `sql` template sites
(`grep -ro 'sql\`' packages/boot/src packages/server/src | wc -l`) are what would need schema
qualification, and they are not behind `DbOps`.

**Replacement text** for §3.4:

> ### 3.4 Falling back to two schemas in one database
>
> Some managed providers hand you exactly one database. That shape is **not supported**, and the
> reason is mechanical rather than a preference. `PgClientConfig`
> (`repos/effect/packages/sql/pg/src/PgClient.ts:80-123`) exposes no `searchPath` and no
> per-connection initialisation hook, so there is nowhere to issue `SET search_path` once per
> pooled connection; the pg URL parser ignores unknown query parameters
> (`PgConnection.ts:2281`), so a `?schema=` in the descriptor would be silently discarded. The
> alternative, schema-qualifying every identifier, would touch all 408 `sql` template sites rather
> than the `DbOps` surface, which is the opposite of keeping the choice behind one interface.
>
> A deployment with one database gets two schemas only if it also gets a `searchPath` option
> upstream in `@effect/sql-pg`, or a connection wrapper comms owns. Until then, R2's two databases
> are a hard requirement and `?schema=` is not part of the grammar in section 4.1.

(§4.1's `?schema=` bullet at line 195 and the `schema` field on the `postgres` descriptor at
line 215 come out with it, or the section states the upstream dependency explicitly.)

---

## 9. WRONG — two-argument `MAX` is a hard error on both remote engines, not a silent semantic change

**Doc line 36:**

> Two-argument `MAX` is a scalar in SQLite and an aggregate in Postgres and MySQL, so that line is a silent semantic change on port rather than a syntax error. Fix it now.

**Doc line 470:**

> Two-argument `MAX` is a scalar function in SQLite and an aggregate everywhere else, so this does not fail on port, it changes meaning.

**What is actually true.** Neither engine accepts the call at all.

- Postgres: `max` is declared `max(anyelement)`. `max(integer, integer)` matches no signature and
  raises `ERROR: function max(integer, integer) does not exist` (42883). Even a one-argument
  aggregate would be rejected here, because Postgres refuses aggregates in an `UPDATE ... SET`
  target list ("aggregate functions are not allowed in UPDATE").
- MySQL: `SELECT MAX(1,2)` raises `ERROR 1582 (42000): Incorrect parameter count in the call to
  native function 'MAX'`.

The remedy the doc prescribes is right; the urgency argument for it is not. It is stated twice,
and both times it is the reason the fix is ranked above ordinary portability work.

**Replacement text** for the relevant sentence in both places:

> Two-argument `MAX` is a scalar function in SQLite only. Postgres rejects it as
> `function max(integer, integer) does not exist` and also forbids aggregates in an `UPDATE …
> SET` target list; MySQL rejects it as `ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT`. It is a loud failure
> on both remote engines rather than a silent one, which makes it cheap to catch but easy to leave
> until the port. Fix it now anyway: `GREATEST` costs the same to write and the SQLite behaviour
> is identical.

---

## 10. WRONG — `cutover.ts:150`'s 30-second timeout does not cover the rehearsal copy

**Doc line 373:**

> Today `packages/boot/src/cutover.ts:150` applies a fixed `Effect.timeout("30 seconds")` around the whole rehearsal, covering both the copy and the child's self-test. That conflates two failures that need different messages.

**What is actually true.** `packages/boot/src/cutover.ts:143` and `:145` run `backup.clone(clone)`
and `backup.prepareClone(clone, epoch)` before the launch at `:146-148`. The
`Effect.timeout("30 seconds")` at `:150` is piped onto `rehearsed.process.health` at `:149`, so it
bounds the child's self-test only. The copy has **no** budget at all today.

For contrast, the hourly path does bound its copy: `packages/boot/src/scheduled-backup.ts:96`
puts `Effect.timeout("10 seconds")` around a block that includes the `backup.clone(saved)` at
`:66`. So the two copy paths in the codebase today have different budgets — one of ten seconds
and one of none — which is a stronger argument for §5.3 than the one the doc makes.

**Replacement text** for line 373:

> Today the rehearsal copy has no budget at all. `packages/boot/src/cutover.ts:143` and `:145`
> clone and prepare before the launch, and the `Effect.timeout("30 seconds")` at `:150` is piped
> onto `rehearsed.process.health` at `:149`, so it bounds only the child's self-test. On SQLite
> that is survivable because `VACUUM INTO` is a local file copy; on a remote engine a dump and
> load can hang indefinitely inside an edit. The hourly path is inconsistent with it in the other
> direction: `packages/boot/src/scheduled-backup.ts:96` wraps its `backup.clone` at `:66` in a
> ten-second budget. Give the copy its own budget in both places:

---

## 11. WRONG — `Migrator.latestMigration` is not exported

**Doc line 599:**

> It becomes a max-applied-id comparison, which `Migrator`'s `latestMigration` already provides: it is `SELECT migration_id, name, created_at FROM <table> ORDER BY migration_id DESC` and takes the first row (`Migrator.ts:162-176`).

**What is actually true.** The query text and line range are right (`Migrator.ts:162-175`), but
`latestMigration` is a `const` bound inside the `Effect.gen` body of `make` and is not reachable
from outside. `grep -n "^export" Migrator.ts` gives the complete public surface:
`MigratorOptions`, `Loader`, `ResolvedMigration`, `Migration`, `MigrationError`, `make`,
`fromGlob`, `fromBabelGlob`, `fromRecord`, `fromFileSystem`. Nothing exposes the latest applied
id, and `make`'s return value is the list of migrations *this run applied*
(`Migrator.ts:112-113`, `:302`), which is empty on a store that is already up to date — precisely
the case the too-new check has to detect.

comms has to run the query itself.

**Replacement text** for the middle of line 599:

> It becomes a max-applied-id comparison, which comms issues itself: `SELECT migration_id FROM
> <table> ORDER BY migration_id DESC LIMIT 1`, the same query `Migrator` runs internally at
> `Migrator.ts:162-175`. `latestMigration` is a local binding inside `Migrator.make`'s generator
> and is not exported, and `make`'s return value is only the migrations *this run* applied
> (`Migrator.ts:302`), which is empty on an already-current store — exactly the case the check
> exists for. Run the comparison before the migrator, alongside the adopt step in section 7.3.

---

## 12. WRONG — `PgMigrator`'s credential mechanism yields an empty environment when the client is configured by URL

**Doc line 386:**

> `repos/effect/packages/sql/pg/src/PgMigrator.ts:48-64` shows Effect shelling out to `pg_dump` via `ChildProcess.make("pg_dump", args, { env })` … with credentials passed as `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE` in the child environment. comms uses the same mechanism, which means:

**What is actually true.** The citation is exact, and the mechanism does not carry credentials
under comms' own configuration. `PgMigrator.ts:55-62` reads `sql.config.host`,
`sql.config.port`, `sql.config.username`, `sql.config.password`, `sql.config.database` and
`sql.config.ssl`. `sql.config` is the options object exactly as it was passed
(`PgClient.ts:152`, `config: options`), and §4.2 line 242 configures the client as
`PgClient.layer({ url, types, applicationName })`. With only `url` set, all six of those fields
are `undefined`. The URL is parsed much later and privately, inside `PgConnection`
(`PgConnection.ts:2138-2158`), and the parsed result never reaches `sql.config`.

An implementer copying `PgMigrator`'s shape gets a `pg_dump` with an empty environment, which
falls back to the ambient `PGHOST`/`PGUSER` or to local socket defaults, and either fails to
connect or — worse on a developer box — dumps the wrong database.

**Replacement text** for the first sentence of line 386:

> `repos/effect/packages/sql/pg/src/PgMigrator.ts:48-64` shows the shape Effect uses:
> `ChildProcess.make("pg_dump", args, { env })` piped through
> `ChildProcessSpawner.ChildProcessSpawner`'s `spawner.string`, with `PGHOST`, `PGPORT`, `PGUSER`,
> `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE` in the child environment. comms uses the same shape
> but **not** the same source for those values. `PgMigrator` reads them from `sql.config`
> (`PgMigrator.ts:55-62`), which is the options object verbatim (`PgClient.ts:152`); comms
> configures the client with `url` alone (section 4.2), so every one of those fields is
> `undefined` there and the URL is parsed privately inside `PgConnection`
> (`PgConnection.ts:2138-2158`). `DbOps` builds the environment from the `StoreDescriptor` it
> already holds, which is the one place the credential is parsed. This means:

---

## 13. WRONG — `MysqlClient.layer`'s error channel includes `Config.ConfigError`

**Doc line 243** and **doc line 245:**

> | `mysql` | `MysqlClient.layer({ url })` | `repos/effect/packages/sql/mysql2/src/MysqlClient.ts:445`, config at `:182-210` |
> … `PgClient.layer` and `MysqlClient.layer` have error type `SqlError` because they connect eagerly (`PgClient.ts:347`, `MysqlClient.ts:445`). So `clientLayer`'s error channel is `SqlError` for every tag, and the SQLite branch widens.

**What is actually true.** `PgClient.layer` is `Layer.Layer<PgClient | Client.SqlClient,
SqlError>` (`PgClient.ts:347-349`) ✓. `MysqlClient.layer` is
`Layer.Layer<MysqlClient | Client.SqlClient, Config.ConfigError | SqlError>`
(`MysqlClient.ts:445-447`). The declared `clientLayer` signature at doc line 234,
`Layer.Layer<SqlClient.SqlClient, SqlError.SqlError>`, will not typecheck for the mysql branch.

**Replacement text** for the second sentence of line 245:

> `SqliteClient.layer` has error type `never` (`SqliteClient.ts:285-293`); `PgClient.layer` has
> `SqlError` (`PgClient.ts:347-349`); `MysqlClient.layer` has `Config.ConfigError | SqlError`
> (`MysqlClient.ts:445-447`), the `ConfigError` being a residue of its layer construction rather
> than anything a concrete config can raise. `clientLayer`'s error channel is therefore
> `SqlError | Config.ConfigError`, the SQLite and Postgres branches widen into it, and the mysql
> branch is the one that determines the type.

---

## 14. WRONG — the `FROM topics` sites in `public-pages.ts` are at `:81`, `:84` and `:134`

**Doc line 37:**

> Two sites violate it today: `packages/boot/src/app-backup.ts:43` reads `MAX(seq) FROM messages` … and `packages/boot/src/public-pages.ts:78` and `:81` read `topics`.

**What is actually true.** `grep -rEn 'FROM (topics|messages|reads|agents)' packages/boot/src`
returns four lines, not three:

- `packages/boot/src/app-backup.ts:43` ✓ as stated
- `packages/boot/src/public-pages.ts:81` ✓
- `packages/boot/src/public-pages.ts:84` — the `archived_at` twin of `:81`, not mentioned
- `packages/boot/src/public-pages.ts:134` — `SELECT path,meta,deleted_at FROM topics WHERE …`,
  not mentioned

Line 78 is `for (const name of names) {` and contains no SQL. The CI grep in the same sentence is
the definition of done for the habit, so an implementer who removes the two cited lines will find
the grep still non-empty.

**Replacement text** for line 37's second sentence:

> Four sites violate it today: `packages/boot/src/app-backup.ts:43` reads `MAX(seq) FROM messages`
> for a rehearsal ceiling boot already holds as `seq.next`, and `packages/boot/src/public-pages.ts`
> reads `topics` at `:81`, `:84` and `:134`.

---

## 15. IMPRECISE — three wrong `file:line` anchors for statements the doc quotes correctly

Each of these quotes the right SQL and points at the wrong line. Grouped because the fix is
identical.

| Doc line | Claim | Actually at |
| --- | --- | --- |
| 485 | `packages/boot/src/auth.ts:321` — `UPDATE sessions SET last_seen_at=? … RETURNING id, expires_at` | `packages/boot/src/auth.ts:339`. Line 321 is a `verifyAssertion` call. |
| 745 | `packages/boot/src/events.ts` `:118` publishes by setting `published_through=next-1` | `packages/boot/src/events.ts:59`, `const finish = sql\`UPDATE seq SET published_through=next-1,pending_id=NULL,…\``. Line 118 is a `topic_move_invalid` error return. |
| 430 | representative `substr(` site `packages/boot/src/events.ts:217` | `packages/boot/src/events.ts:216`. Line 217 is the `requestActor` filter and contains no `substr`. |

The five `RETURNING` statements themselves are exactly the five the doc lists — `grep -rn
RETURNING packages/boot/src packages/server/src` returns those and nothing else.

---

## 16. IMPRECISE — §17's `Uint8Array` and ledger-DDL "corrections" invert the investigation's correct line numbers

**Doc line 1190:**

> | `Statement.ts:1136` classifies `Uint8Array` | `Statement.ts:1135` |

`grep -n "instanceof Uint8Array" Statement.ts` gives `1136`. Line 1135 is `return "Date"`. The
investigation was right and the correction introduces the error. The same claim is repeated at
doc line 617.

**Doc line 1187:**

> | `Migrator.ts:120-151` creates the ledger per dialect | `Migrator.ts:120-150` |

`ensureMigrationsTable` runs from `120` (`const ensureMigrationsTable = sql.onDialectOrElse({`)
to `151` (`})`). Line 150 is the closing backtick of the `orElse` branch's DDL. The investigation
was right here too.

Both rows should be deleted from §17 and doc line 617's `Statement.ts:1135` changed to
`Statement.ts:1136`.

---

## 17. IMPRECISE — `storage-volume.ts:17-43` is the parser, not the probe, and the two binaries are the other way round

**Doc line 369** and **doc line 1197:**

> The existing probe shells out to `df`/`stat -f` and parses fixed numeric output (`storage-volume.ts:17-43`)
> | `DbOps.capacity` on SQLite returns `statvfs` | There is no `statvfs` call; `storage-volume.ts:17-43` shells `df`/`stat -f` and parses |

**What is actually true.** The conclusion is right — there is no `statvfs` call — and everything
else in the citation is off. `storage-volume.ts:18-45` is `parseStorageVolume`, a pure function
over a string. The shell-out is `readStorageVolume` at `:48-84`, and it picks per platform at
`:61-62`:

```ts
platform === "linux" ? "/usr/bin/stat" : "/bin/df",
platform === "linux" ? ["-f", "-c", "%S %b %a", "--", directory] : ["-kP", "--", directory],
```

So `stat -f` is the **Linux** path and `df -kP` is the **darwin** path, which is the reverse of
the reading "`df`/`stat -f`" invites given that comms deploys on Linux. §5.2's table at line 365
cites a third range, `:18-43`, for the same thing.

**Replacement text** for line 369:

> `capacity` on SQLite is **not** a `statvfs` call. `readStorageVolume`
> (`packages/boot/src/storage-volume.ts:48-84`) spawns `/usr/bin/stat -f -c '%S %b %a'` on Linux
> and `/bin/df -kP` on darwin (`:61-62`) under `LC_ALL=C` and a two-second timeout, and
> `parseStorageVolume` (`:18-45`) accepts only fixed numeric output. `DbOps.capacity` delegates to
> it rather than introducing a second mechanism.

---

## 18. IMPRECISE — "49 sites" for `isDescendant` is an occurrence count of `substr(`, not a site count

**Doc line 430:**

> The investigation counted 33 occurrences of `substr(`; at the current head it is **49** … Representative sites: …

and **doc line 946** (§13 step 3):

> Do `isDescendant` first (49 of the roughly 100 sites)

**What is actually true.** The 49 is exact and verified
(`grep -ro 'substr(' packages/boot/src packages/server/src | wc -l` → 49). It is not the
`isDescendant` count. 42 of the 49 have the prefix-match shape; the other seven are four distinct
other uses:

- suffix rewrite during a topic move, three times: `events.ts:128`,
  `packages/server/src/kernel/topic-move.ts:116` and `:120` — `substr(topic,length(${from})+1)`
- literal-prefix type test, twice: `events.ts:218` and `:222` — `substr(…,1,8)` and
  `substr(value,1,length(value)-1)`
- the wildcard end test, once: `events.ts:222` — `substr(value,-1)`, which is finding 4
- a transaction-id prefix, once: `packages/server/src/kernel/operational-events.ts:48`

Three of those seven need their own portability treatment (finding 4 for the negative offset; the
three suffix rewrites also carry `||` concatenation that MySQL needs `CONCAT` for, and `||` in a
value position is not what `isDescendant` emits).

**Replacement text** for the count sentence at line 430:

> The investigation counted 33 occurrences of `substr(`; at the current head there are 49
> (`grep -ro 'substr(' packages/boot/src packages/server/src | wc -l`), of which **42** are this
> prefix-match shape. The other seven are three different constructs and none of them is served by
> this helper: a suffix rewrite during a topic move at `events.ts:128`,
> `packages/server/src/kernel/topic-move.ts:116` and `:120`, which also concatenates with `||` in
> a value position and so needs `CONCAT` on MySQL; two literal-prefix tests at `events.ts:218` and
> `:222`, which are portable as written; the wildcard end test at `events.ts:222`, which is
> section 6.2a; and a transaction-id prefix at
> `packages/server/src/kernel/operational-events.ts:48`. Step 3's estimate should use 42.

---

## 19. IMPRECISE — `jsonArrayHas`'s two sites are not the same shape and the helper covers only one

**Doc line 444** (§6.4 heading, "— 2 sites") and the table at lines 447 to 450.

**What is actually true.** The count of two is right (`grep -rn json_each`), and the two are
different problems.

`packages/server/src/kernel/messages.ts:283` is what the helper describes:
`EXISTS (SELECT 1 FROM json_each(visible_messages.tags) WHERE value=${input.tag ?? null})` — a
column, a bound scalar.

`packages/boot/src/events.ts:222` is not. Its first argument is a **bound JSON string parameter**
(`typesJson`, built at `:214`), not a column, and its predicate is a three-way disjunction
including the wildcard logic from finding 4. Neither the signature `jsonArrayHas(sql, column,
value)` nor the MySQL emission `JSON_CONTAINS(col, JSON_QUOTE(value), '$')` can express it. On
Postgres the pg emission also needs an explicit `::jsonb` cast, because a bound string arrives
with OID 0 (finding 3) and `jsonb_array_elements_text($1)` cannot infer it.

**Replacement text** for §6.4's heading and a closing note:

> ### 6.4 `jsonArrayHas(sql, column, value)` — 1 site
>
> … The one site is `packages/server/src/kernel/messages.ts:283`, the tag filter. On Postgres the
> argument must be cast (`jsonb_array_elements_text(${col}::jsonb)`) when it is a bound value
> rather than a `jsonb` column, per section 6.7a.
>
> The other `json_each` use, `packages/boot/src/events.ts:222`, is deliberately **not** routed
> through this helper. Its first argument is a bound JSON string rather than a column, and its
> predicate carries the wildcard test from section 6.2a, so it gets its own three-dialect
> fragment and its own generated-SQL test.

---

## 20. IMPRECISE — the `GROUP BY` fix is safe for the first `UNION` branch only

**Doc line 568:**

> `packages/boot/src/agent-roster.ts:15-23` selects `e.agent_name`, `e.kind`, `e.host`, `e.collected_at` while grouping only by `e.family`. … The fix is to add the bare columns to the `GROUP BY`, since `family` is unique in `enrollments` (`packages/boot/src/enrollment-schema.ts:30`) so the grouping is unchanged.

**What is actually true.** The diagnosis and the uniqueness argument are exactly right for the
first branch (`agent-roster.ts:15-18`; `family TEXT NOT NULL UNIQUE` verified at
`enrollment-schema.ts:30`). The query is a three-way `UNION ALL`, and the **second** branch has
the same problem with a different answer:

```
agent-roster.ts:20-22
SELECT t.agent,'agent' AS kind,t.family AS instance,t.label,MIN(t.created_at),MAX(t.last_used_at)
FROM tokens t WHERE t.kind='access' AND NOT EXISTS (…) GROUP BY t.family
```

`t.agent` and `t.label` are bare, and `tokens.family` is **not** unique — a family has many token
rows, which is the whole reason `MIN`/`MAX` appear there. Adding `t.agent, t.label` to the
`GROUP BY` would split a family into several rows whenever any token row disagreed. The portable
fix for that branch is `MIN(t.agent)` and `MIN(t.label)`, which is exactly the shape
`packages/boot/src/account-queries.ts:56-62` already uses and the doc already points at.

**Replacement text**, appended to line 568:

> The same query's second `UNION ALL` branch at `:20-22` has the same problem and a different fix:
> it selects `t.agent` and `t.label` bare while grouping by `t.family`, and `tokens.family` is not
> unique — a family has many token rows, which is why `MIN(t.created_at)` and
> `MAX(t.last_used_at)` are there already. Adding those columns to the `GROUP BY` would split one
> family into several rows. Wrap them in `MIN()` instead, exactly as
> `packages/boot/src/account-queries.ts:56-62` does.

---

## 21. IMPRECISE — `INSERT IGNORE` is not the MySQL equivalent of `DO NOTHING`

**Doc line 464:**

> A `set` of `[]` means `DO NOTHING` on SQLite and Postgres and `INSERT IGNORE` on MySQL, which covers the five `INSERT OR IGNORE` sites and `packages/boot/src/tokens.ts:137`.

**What is actually true.** The site inventory is exact — five `INSERT OR IGNORE` occurrences
(`app-recovery.ts` ×2, `application.ts` ×2, `generations.ts` ×1) plus `tokens.ts:137`'s
`ON CONFLICT(family,key_hash) DO NOTHING`, verified.

`INSERT IGNORE` is wider than `DO NOTHING`. It downgrades to warnings every error the statement
can raise, not only duplicate keys: data truncation, out-of-range numerics, `NOT NULL` violations
converted to implicit defaults, foreign-key failures. On a token-binding statement
(`tokens.ts:137`) or a writer-fence seed (`app-recovery.ts:42`) that turns a constraint violation
into a silently skipped row. The narrow equivalent is `ON DUPLICATE KEY UPDATE <pk>=<pk>`, which
suppresses exactly the duplicate-key case and nothing else.

**Replacement text** for line 464:

> A `set` of `[]` means `ON CONFLICT (…) DO NOTHING` on SQLite and Postgres and
> `ON DUPLICATE KEY UPDATE <first conflict column>=<first conflict column>` on MySQL — **not**
> `INSERT IGNORE`, which downgrades every error the statement can raise to a warning, including
> truncation, range and `NOT NULL` failures, and would turn a real constraint violation into a
> silently skipped row. It covers the five `INSERT OR IGNORE` sites and
> `packages/boot/src/tokens.ts:137`.

---

## 22. IMPRECISE — the MySQL `DELETE`-with-`RETURNING` substitution drops the retention predicate

**Doc line 486** and **doc line 1058:**

> | `packages/boot/src/event-retention.ts:36-38` | `DELETE FROM events WHERE … RETURNING seq` | `SELECT` the candidate `seq` values first, then `DELETE … WHERE seq IN (…)` |

**What is actually true.** The two statements are not interchangeable in the way the phrasing
suggests. `event-retention.ts:31`'s select is a **range scan only**:

```sql
SELECT seq FROM events WHERE seq>${cursor} AND seq<=${fence} ORDER BY seq LIMIT 256
```

The retention predicate lives entirely in the `DELETE` at `:36-38` (the
`json_extract(event,'$.at') < CASE WHEN … 'http.request' THEN … ELSE … END` age test), and
`removed.length` at `:39` counts rows that actually matched it. Read literally, "select the
candidate `seq` values first, then delete by that list" deletes all 256 rows in the window,
including young ones. The comment at `:29` ("Bound rows scanned, not just rows deleted") says why
the two are separate.

**Replacement text** for the table cell at line 486:

> `SELECT seq FROM events WHERE seq>? AND seq<=? AND <the age predicate> ORDER BY seq LIMIT 256`,
> then `DELETE … WHERE seq IN (…)`. The age predicate must move into the select: the existing
> select at `:31` is a range scan only and the predicate lives in the `DELETE` at `:36-38`, so
> deleting by the range-only candidate list would remove young rows. `deleted` then counts the
> select's rows rather than the delete's.

---

## 23. IMPRECISE — `to_regclass` is not the Postgres equivalent of the SQLite `tableExists` probe

**Doc line 367:**

> | `tableExists` | `SELECT name FROM sqlite_master WHERE type='table' AND name=?` | `SELECT to_regclass(?) IS NOT NULL AS present` | … |

**What is actually true.** The SQLite form filters `type='table'` (verified at the one call site,
`packages/boot/src/public-pages.ts:67`, which is the "does the app store have a domain schema
yet" probe). `to_regclass` resolves **any** relation — table, view, materialized view, index,
sequence, foreign table — and resolves it through `search_path`, so it also matches a relation of
that name in another schema on the path. The probe is looking for a specific table, and a view or
an index of the same name would make it answer yes.

**Replacement text** for the pg cell at line 367:

> `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname=current_schema() AND c.relname=?::text` — `to_regclass` is shorter and wrong here, because it resolves views, indexes and sequences as well as tables and follows `search_path` into other schemas.

---

## 24. IMPRECISE — "SET TRANSACTION ISOLATION LEVEL after a savepoint is an error" states the wrong rule

**Doc line 501:**

> `SET TRANSACTION ISOLATION LEVEL` after a savepoint is an error on Postgres, so the nesting check is required, not defensive.

**What is actually true.** The conclusion holds; the rule does not. Postgres raises `25001 SET
TRANSACTION ISOLATION LEVEL must be called before any query` when a query or data-modifying
statement has already run in the transaction. `SAVEPOINT` is not such a statement: issued
immediately after a `SAVEPOINT` with no query in between, the `SET` succeeds. What makes the
nested case an error in practice is that a nested `withTransaction` implies statements already
ran on that connection — which is a different and more robust argument, since it also covers the
nested-with-no-savepoint case.

**Replacement text** for that sentence:

> Postgres raises `25001 SET TRANSACTION ISOLATION LEVEL must be called before any query` once any
> query or data-modifying statement has run in the transaction. A nested `readTransaction` is by
> definition inside a transaction that has already run statements, so the nesting check is
> required, not defensive. (A bare `SAVEPOINT` alone does not trigger `25001`; it is the
> statements before it that do.)

---

## 25. IMPRECISE — the `REPEATABLE READ` serialization-failure argument is Postgres-only

**Doc line 719:**

> **Write transactions must stay at READ COMMITTED.** This is the trap. Under `REPEATABLE READ`, a concurrent `UPDATE` on the same row does not block and then return zero rows; it raises a serialization failure (`40001`).

**What is actually true** for Postgres, and **not** for MySQL, which is now a shipping engine and
whose InnoDB default *is* `REPEATABLE READ` — a fact the doc states two paragraphs later at line
735. InnoDB performs a current read for a locking `UPDATE`: it waits on the X lock, then
re-evaluates the `WHERE` clause against the latest committed version. The stale writer's
`WHERE … AND epoch=?` simply matches nothing and the statement reports zero matched rows. No
`40001`.

So the rule "write transactions must stay at READ COMMITTED" is a Postgres rule stated as a
universal one, and following it literally on MySQL would mean issuing a `SET TRANSACTION
ISOLATION LEVEL READ COMMITTED` that finding 6's `ER_CANT_CHANGE_TX_CHARACTERISTICS` forbids
inside an open transaction anyway.

**Replacement text** for line 719:

> **Postgres write transactions must stay at READ COMMITTED.** This is the trap, and it is
> Postgres-specific. Under Postgres `REPEATABLE READ`, a concurrent `UPDATE` on the same row
> blocks and then raises a serialization failure (`40001`) rather than returning zero rows, so
> every concurrent write would surface as a retriable serialization error instead of the typed
> `stale_writer` the kernel expects. MySQL does not share the hazard even though InnoDB defaults
> to `REPEATABLE READ`: a locking `UPDATE` there performs a current read, waits for the X lock and
> re-evaluates its `WHERE` clause against the latest committed row, so the stale writer matches
> zero rows exactly as it does at READ COMMITTED. Apply the isolation prelude in section 9.2 to
> read transactions only. Never to `mutate()`.

---

## 26. IMPRECISE — the `FOR SHARE` prelude cancels most of the read-concurrency the doc counts as a remote-engine gain

**Doc line 717:** "the same serialization guarantee without a file-level lock, so unrelated
transactions no longer wait." **Doc line 1089** lists read concurrency as something SQLite costs
you.

**What is actually true.** Both statements are right in isolation and the design puts them in
tension. §9.2's prelude has every one of the six published-image read paths take
`SELECT epoch FROM kernel_writer FOR SHARE` and hold it for the transaction's duration, and line
737 says so plainly: "readers and writers serialize on one row exactly as they serialize on the
file today". A reader therefore blocks the writer's fence `UPDATE` on Postgres for the whole read,
and a writer blocks the reader. What the remote engine actually buys is that transactions
touching *neither* the fence row nor the store's write lock no longer queue — which is real, but
it is not the six read paths that carry the board's traffic.

**Replacement text**, appended to line 737:

> This is a deliberate trade: it buys the `previous`-column correctness argument above at the cost
> of the read concurrency a remote engine would otherwise give these six paths. Reads that do not
> go through `readTransaction` — the raw SQL route, `/_boot/*` — still run concurrently, and so do
> unrelated writes, which is the gain section 9.1 claims. The published-image reads specifically
> keep SQLite's serialization, on purpose.

---

## 27. IMPRECISE — `readTransaction`'s site count is given as seven, six and six

**Doc line 354:** "used by seven server read paths".
**Doc line 490:** "### 6.9 `readTransaction(sql, effect)` — 6 sites".
**Doc line 723:** "Six read paths open with a throwaway `SELECT epoch FROM kernel_writer`".

**What is actually true.** Six, and the doc's own list at line 723 is exactly right, verified line
by line: `messages.ts:246`, `messages.ts:294`, `topics.ts:49`, `topics.ts:127`,
`extension-data.ts:63`, `pages.ts:38`. Change "seven" at line 354 to "six".

---

## 28. IMPRECISE — `messages.tags` is treated as `jsonb` in §6.10 and omitted from §7.2's JSON column list

**Doc line 548:**

> | JSON (`settings.value`, `events.event`, `messages.meta`, `messages.previous`) | `TEXT` | `jsonb` | `JSON` |

**Doc line 512:**

> | `tags` | JSON text, parsed by `fromJsonString` | `CASE WHEN … THEN previous->>'tags' ELSE tags::text END` |

`tags::text` only makes sense if `tags` is `jsonb`; if it were `text` the cast is a no-op and the
column is already what `fromJsonString` wants. `packages/server/src/kernel/messages.ts:283` also
runs `json_each(visible_messages.tags)` over it, and §6.4's pg form
(`jsonb_array_elements_text`) requires `jsonb`. The §7.2 list should include `messages.tags`.

**Replacement text** for line 548:

> | JSON (`settings.value`, `events.event`, `messages.tags`, `messages.meta`, `messages.previous`) | `TEXT` | `jsonb` | `JSON` |

---

## 29. IMPRECISE — assorted vendored-source line ranges that are off by one or point at the wrong construct

All verified against `4.0.0-rc.113`. None of these changes a conclusion; all of them will send a
reader to the wrong line.

| Doc line | Cited | Actual |
| --- | --- | --- |
| 241 | `SqliteClient.ts:285-299` for `layer`, config at `:89-107` | `layer` is `285-293`; `SqliteClientConfig` is `89-106` (`:107` is blank) |
| 366 | readonly "opens the file read-only (`:136-140`)" | the `new Database(…, { readonly, … })` call is `131-136`; `138-142` is `busyTimeout` |
| 402, 1188 | `onDialect` at `Statement.ts:518-525` | `518-524`; `:525` is blank. `onDialectOrElse` at `526-533` ✓ |
| 462 | `sql.insert` at `Statement.ts:465-471` | `465-470` |
| 243 | `MysqlClientConfig` at `:182-210` | `182-209` (`:210` is blank) |
| 1076 | `MysqlClient`'s compiler stubs at `MysqlClient.ts:467-474` | `472-477`; `467-471` is `onIdentifier` |
| 841 | pg placeholders at `PgClient.ts:366-368` | `367-369` |
| 569 | `OID` table at `PgTypes.ts:281-327` | `282-329` |
| 575 | `Codec<A>` at `PgTypes.ts:875-891` | `876-891` |
| 617 | `Schema.Uint8Array` at `source-schema.ts:28` | `:30`; `:28` is `export const Image = Schema.Struct({` |
| 120 | boot creates the three tables at `app-recovery.ts:39-42` | `39-41`; `:42` is the `INSERT OR IGNORE` seed |
| 499 | `Migrator.make` takes `{ dumpSchema }` at `Migrator.ts:100-106` | `100-107` |
| 352 | the `Context.Service<Self, Shape>()` form at `pg/test/utils.ts:9` | that file uses the one-parameter `Context.Service<PgContainer>()("tag", { make })` form; the two-parameter form comms uses is at `mysql2/test/utils.ts:21-24` |
| 553 | "64-hex epochs and attempts (`supervisor.ts:96-98`)" | `:97-98`; `:96` is `owners.reserve(generation.n)` |
| 741 | "See sections 12.3 and 15" | section 16 since the renumbering; §15 is now the transfer procedure |

---

## 30. IMPRECISE — `Text key (15 columns …)` undercounts, and the 3072-byte claim has no headroom

**Doc line 546** and **line 553.**

`grep -roh "TEXT PRIMARY KEY" packages/boot/src packages/server/src | wc -l` returns **20**, not
15. The composite-PK count of 11 is exact
(`grep -rohE "PRIMARY KEY ?\([^)]*,[^)]*\)" … | wc -l` → 11).

On the index-limit claim: `utf8mb4` at `VARCHAR(256)` is 1024 bytes per column, and InnoDB's
`DYNAMIC` row format caps an index key at 3072 bytes. The widest composite key in the schema is
`reactions(message_id, instance, emoji)` (`packages/server/src/kernel/database.ts:57`) at exactly
3 × 1024 = 3072. It fits, with zero headroom: any future four-column text key, or a widening past
256, fails at `CREATE TABLE`. Worth saying, since the doc presents the width as comfortably
sufficient.

**Replacement text** for the last sentence of line 553:

> MySQL's `utf8mb4` 3072-byte index limit accommodates the composite keys at that width, but only
> just: the widest is `reactions(message_id,instance,emoji)`
> (`packages/server/src/kernel/database.ts:57`) at exactly 3 × 1024 bytes. A fourth text column in
> a composite key, or a width past 256, fails at `CREATE TABLE` on MySQL and nowhere else. Prefer
> the narrowest `VARCHAR` each column actually needs over a uniform 256 if a future key gets wider.

---

## 31. IMPRECISE — the derived-table alias rule has a second site the doc does not list

**Doc line 843** names one site, `sql-read.ts:37`.

`packages/boot/src/app-backup.ts:43` also has an unaliased derived table:

```sql
SELECT MAX(value) AS ceiling FROM (SELECT COALESCE(MAX(seq),0) value FROM messages
  UNION ALL SELECT COALESCE(MAX(seq),0) value FROM outbox)
```

Postgres and MySQL both require the alias. This site is slated for removal by base-work item 21
(it is one of the two the doc's own CI grep at line 37 flags), so it may never need the fix — but
if item 21 slips, the port breaks here and §11 says the alias rule has one site.

`packages/server/src/kernel/published-messages.ts:14` already carries its alias (`) topic`) and is
fine.

---

## 32. IMPRECISE — the MySQL grant script uses a `?` placeholder that `mysql` will not accept

**Doc lines 146 to 147:**

```sql
CREATE USER 'comms_boot'@'%' IDENTIFIED BY ?;
CREATE USER 'comms_app'@'%'  IDENTIFIED BY ?;
```

The Postgres script's `:'boot_password'` at line 91 is real `psql` variable interpolation, invoked
as the doc says at line 85 with `psql -v`. `?` is not a `mysql` client construct; the client has
no parameter binding for a script. The file would have to use a literal, a shell-substituted
heredoc, or `mysql --init-command` with the operator's own quoting. Given that the surrounding
prose stresses "credentials never on the command line", the mechanism deserves to be stated
rather than implied by a placeholder that does not exist.

---

## 33. IMPRECISE — the collation assertion checks the database default, not the columns

**Doc line 1068** (§14.4 item 5):

> **Compensation:** `utf8mb4_0900_as_cs` set explicitly on both databases by the grant script, and a startup assertion that reads `information_schema.SCHEMATA` and refuses to run against an accent-insensitive database.

`information_schema.SCHEMATA.DEFAULT_COLLATION_NAME` reports the database default only. A column
created with an explicit collation, or a table created before the default was changed, keeps its
own — and the check would pass. `information_schema.COLUMNS.COLLATION_NAME` over the actual
identifier columns is the assertion that matches the claim. Small change, and it is the difference
between an assertion that proves the property and one that proves an adjacent property.

---

## 34. UNVERIFIABLE — the `int8` codec registration is API-correct but its blast radius is not stated

§7.5 (doc lines 606 to 617) is verified in every API particular: `PgTypes.makeRegistry()` at
`PgTypes.ts:1378`, `Registry.register` as `<A>(oid, codec, options?) => void` at `:382-384`,
`Codec<A>` as `{ encode, decode, write?, read? }` returning `Result.Result` at `:876-891`, the
`int8` codec returning `scratchView8.getBigInt64(0)` at `:1236-1249`, `PgClientConfig.types` at
`PgClient.ts:101` and consumed at `PgConnection.ts:243`. The claim that the decode is
unconditional is right: `SqlClient.SafeIntegers` (`SqlClient.ts:385`) is read only by the
sqlite-bun adapter (`grep -rn SafeIntegers` across the four adapters returns
`sqlite-bun/src/SqliteClient.ts:160`, `:173` and nothing else).

What I could not verify is the consequence for one existing caller. `packages/server/src/kernel/
sql-read.ts:39` provides `SqlClient.SafeIntegers, true` and `:46-49` narrows returned `bigint`s to
`number` when they are in safe range. On Postgres, `SafeIntegers` does nothing and the narrowing
is the only thing keeping `/api/sql` working — until the registry lands, after which the codec
narrows first and `:46-49` becomes unreachable on that engine. More importantly, a registered
codec that fails outside the safe range (which §7.5 requires, correctly) turns an out-of-range
`int8` in an agent's arbitrary `SELECT` into a `SqlError` and then a `query_invalid`, where today
it is a typed rejection at `:50-57`. The observable behaviour is similar; whether it is identical
depends on how `CodecError` is classified, which I could not trace to a `SqlErrorReason`. Worth a
sentence in §7.5 and a case in the pglite suite.

---

---

# Second pass: the material new in the 1203-line version

Sections re-read with the same lens after the "all three engines ship" rewrite: §2 (R4, R4a,
R4b), §3.3, §8.2 to §8.4, §12.2, §12.3, §13 steps 6 and 8, §14.4, §15.

One item the lead flagged as stale, confirmed stale: **§13 step 0 edit 1** (doc lines 902 to 904)
says "MySQL is designed for and not shipped" still stands in `SPEC.md` §12 and `docs/tech.md` §4
and §12. `grep -rn "not shipped" SPEC.md docs/tech.md` returns nothing, so that text is already
corrected and step 0's first edit is done. Not counted as a finding; the step should drop it and
say so, since line 908 makes it the gate on step 6.

---

## 35. BREAK — `mysqldump` needs the global `PROCESS` privilege, which the MySQL grant script cannot give at database level

**Doc lines 157 to 164** grant `comms_boot` database-scoped privileges only:

```sql
GRANT CREATE, DROP, ALTER, SELECT, INSERT, UPDATE, DELETE, REFERENCES
  ON comms_app.* TO 'comms_boot'@'%';
GRANT ALL PRIVILEGES ON `comms_rehearsal\_%`.* TO 'comms_boot'@'%';
```

**Doc line 361** and **doc line 974** then have `DbOps` shell out to
`mysqldump --single-transaction --routines`.

**What is actually true.** Since MySQL 8.0, `mysqldump` queries
`INFORMATION_SCHEMA.FILES` to emit tablespace statements, and that query requires the **`PROCESS`**
privilege. Without it the dump aborts with "Access denied; you need (at least one of) the PROCESS
privilege(s) for this operation". `PROCESS` is a global (`*.*`) privilege: it cannot be granted
`ON comms_app.*`, so no addition to the existing database-scoped grants fixes it. The documented
workaround is `--no-tablespaces`, which the doc does not pass.

This is the MySQL twin of finding 1: `backup`, `cloneForRehearsal` and the weekly drill all fail
on a correctly-provisioned MySQL server, and the failure is a privilege error from a subprocess
rather than a `SqlError`, so it surfaces as `DbOpsError { code: "backup_failed" }` with the real
cause only in the captured stderr.

Separately, `--routines` is dead weight: comms defines no stored routines (no `CREATE PROCEDURE`
or `CREATE FUNCTION` anywhere in `packages/`), and on 8.0 dumping routines brings its own
privilege requirements on `INFORMATION_SCHEMA.ROUTINES`.

**Replacement text** for the MySQL cells at doc lines 360 and 361, and a fourth note in §3.3:

> `mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF` to
> `backups/<id>.sql`, fsynced, size recorded.

> **`mysqldump` must be run with `--no-tablespaces`.** MySQL 8.0's `mysqldump` reads
> `INFORMATION_SCHEMA.FILES` to emit tablespace statements, which requires the global `PROCESS`
> privilege. `PROCESS` is only grantable at `*.*`, so granting it would hand `comms_boot` the
> right to see every statement every connection on the server is running — a much wider
> permission than the two-database boundary allows. `--no-tablespaces` removes the requirement
> and comms has no tablespace to preserve. `--routines` is dropped for the same reason and
> because comms defines no stored routines.

---

## 36. BREAK — MySQL boolean mode combines terms with OR, so the sanitiser as specified inverts the search contract

**Doc line 690:**

> Query safety is stripping the boolean operators `+ - > < ( ) ~ * " @` from caller terms and re-quoting phrases, then `MATCH(body) AGAINST (? IN BOOLEAN MODE)`.

**Doc line 694** states the contract the route promises: "terms combined with AND".

**What is actually true.** In MySQL boolean mode a term with no operator prefix is *optional*: the
default combinator is OR, and `+` is what makes a term required. The recipe at line 690 strips
`+` from the caller's text and never says to add comms' own, so a two-term search returns every
message matching **either** term. That is not "fewer results"; it is a different and much larger
result set, and it silently breaks the documented AND contract on one of three shipping engines.

It also falsifies §8.4's safety argument at doc line 707 — "A term MySQL drops produces fewer
results, never wrong ones, and never an error" — which is the reason the section gives for the
divergence being acceptable to document rather than fix.

SQLite is unaffected: `messages.ts:268` builds the expression by joining quoted parts with
`" AND "` explicitly. Postgres is unaffected for this reason (`websearch_to_tsquery` ANDs adjacent
words) though it has its own problem, finding 38.

**Replacement text** for line 690:

> Query safety has two halves on MySQL. First, strip the boolean operators `+ - > < ( ) ~ * " @`
> from caller terms, as on SQLite. Second — and this is the half that is easy to miss — prefix
> every surviving term and every re-quoted phrase with `+`, because boolean mode treats an
> unprefixed term as *optional* and combines terms with OR. Without the `+`, a two-term search
> returns everything matching either term, which is not a degradation of the AND contract at
> doc §8.4 but a reversal of it. The emitted form is
> `MATCH(body) AGAINST ('+term1 +"a phrase"' IN BOOLEAN MODE)`, and section 12.3 gets a test
> asserting that a two-term search returns only messages containing both.

---

## 37. WRONG — §8.4 misses the divergence that will actually surprise people: InnoDB has a stopword list and the other two engines do not

**Doc lines 696 to 697** name exactly two divergences, short terms on MySQL and diacritics on
Postgres, and **doc line 699** says "Neither is a contract change on SQLite, which remains the
reference."

**What is actually true.** There is a third, and it is the one an agent hits first. InnoDB
full-text search applies a stopword list by default (`innodb_ft_enable_stopword` is `ON`, using a
built-in list of common English words: `the`, `and`, `for`, `you`, `are`, `was`, and roughly thirty
more). A search for any of those returns nothing on MySQL.

Neither other engine does this:

- SQLite's `fts5` with `tokenize='unicode61 remove_diacritics 2'`
  (`packages/server/src/kernel/database.ts:59`) has no stopword concept at all.
- Postgres's `simple` text-search configuration — which §8.2 requires at doc lines 666 and 675 for
  immutability — uses the `simple` dictionary, which lowercases and nothing else. It does not
  remove stopwords; the `english` configuration would.

So MySQL is the only engine of the three that silently discards whole words, and the route
description written at doc line 703 mentions only token length. "Search for `the`" returning zero
results is a more likely first encounter than "search for a two-character term".

**Replacement text**, a third bullet after doc line 697 and an addition to the route text at 703:

> - **MySQL drops common words.** InnoDB enables a built-in stopword list by default
>   (`innodb_ft_enable_stopword`), so `the`, `and`, `for` and about thirty other common English
>   words match nothing. SQLite's `fts5` has no stopword list, and Postgres's `simple`
>   configuration — required by section 8.2 for immutability — removes none either, so this is
>   MySQL-only and it is the divergence an agent meets first.

> **Engine differences: on MySQL, terms shorter than the server's minimum token length (3 by
> default) and terms on the server's full-text stopword list are ignored, so `ok` and `the` each
> match nothing; on Postgres, accented and unaccented forms match each other only when the
> `unaccent` extension is available. `GET /api/sql` reports the deployment's engine.**

This also needs a line in §14.4 item 6, which currently points at §8.3 and §8.4 for "search drops
short terms" and inherits their incompleteness.

---

## 38. WRONG — `websearch_to_tsquery` hands the caller three operators, which is the opposite of the contract's "No raw FTS operators"

**Doc line 675:**

> `websearch_to_tsquery` never raises on arbitrary input, which is the exact safety property the hand-rolled quoting at `packages/server/src/kernel/messages.ts:257-268` provides on SQLite, and it treats adjacent words as AND and double-quoted runs as phrases, which matches the documented contract.

**What is actually true.** Both halves of the sentence are individually right and the conclusion
does not follow. `websearch_to_tsquery` is total on arbitrary input ✓, and it does AND adjacent
words and honour quoted phrases ✓. It also implements the rest of the web-search syntax: the bare
word **`or`** becomes a disjunction, and a **leading `-`** becomes negation. Those are live for
any caller text, because nothing strips them.

The SQLite path deliberately does not allow this. `messages.ts:257-268` validates and then
`:268` re-quotes every part — `parts.map((part) => \`"${part.replaceAll('"', "")}"\`).join(" AND ")`
— so a caller searching for `cats or dogs` on SQLite gets three ANDed literal terms including the
literal token `or`. On Postgres the same search becomes `cats | dogs`. And `-foo` is a term on
SQLite and a negation on Postgres.

The route description at `packages/server/src/search-http.ts:21` promises "No raw FTS operators"
(verified verbatim). Postgres would be the engine that breaks that promise, and §8.4 does not list
it among the divergences.

The property §8.2 actually needs from the Postgres side is not "never raises" but "interprets
nothing the caller did not ask for", and `plainto_tsquery` has it: it ANDs every word and treats
`or` and `-` as ordinary text. The cost is losing quoted phrases, which the contract does promise,
so the honest options are to keep `websearch_to_tsquery` and document two more divergences, or to
build the `tsquery` from the already-parsed `parts` array at `messages.ts:258` with
`phraseto_tsquery` per phrase and `plainto_tsquery` per term, joined with `&&`.

**Replacement text** for doc line 675:

> The query side is `body_tsv @@ websearch_to_tsquery('simple', ?)`. `websearch_to_tsquery` never
> raises on arbitrary input, which is the safety property the hand-rolled quoting at
> `packages/server/src/kernel/messages.ts:257-268` provides on SQLite, and it ANDs adjacent words
> and honours double-quoted phrases. It also implements the rest of the web-search syntax, which
> the contract does not promise: a bare `or` becomes a disjunction and a leading `-` becomes
> negation, where SQLite's `:268` re-quotes every part and so treats both as literal terms.
> Building the `tsquery` from the parts array comms has already parsed at `:258` — one
> `phraseto_tsquery('simple', part)` per quoted phrase, one `plainto_tsquery('simple', part)` per
> bare term, joined with `&&` — keeps the contract exact on all three engines and keeps the
> never-raises property, because both of those functions are total too. Prefer it;
> `websearch_to_tsquery` is the shortcut that quietly adds two operators.

---

## 39. WRONG — §15.1's "What moves" inventory omits nine boot tables and four app tables

**Doc lines 1109 to 1110**, the table headed "What moves":

> | Boot | `passkeys`, `sessions`, `tokens`, `enrollments`, `refresh_receipts`, `seq`, `versions`, `source_batches`, `source_changes`, `staging`, `edit_lock`, `generations`, `backups`, `settings`, `event_batches`, `events` | … |
> | App | `topics`, `messages`, `reads`, `kv`, `agents`, `idempotency`, plus the three shared recovery tables and `public_paths` | The board. |

**What is actually true.** Every name listed is real — I checked each against the `CREATE TABLE`
statements, including `refresh_receipts`, which I initially suspected was a typo for
`refresh_idempotency` and which does exist. The inventory is incomplete rather than wrong.

`grep -rohE "CREATE TABLE (IF NOT EXISTS )?[a-z_]+" packages/boot/src packages/server/src` returns
37 tables. Missing from the boot row: `auth_challenges`, `child_attempts`, `cutover`,
`db_restore_requests`, `mint_receipts`, `refresh_idempotency`, `topic_moves`, `topic_page_moves`,
`webhook_subscriptions`. Missing from the app row: `reactions`, `reaction_idempotency`,
`read_idempotency`, `topic_idempotency`.

Step 7 at doc line 1140 does say "Copy every remaining table", so an implementer following the
procedure copies everything. But §15.1 presents itself as the inventory, R4b is stated as "without
losing a `seq`, an event, a token or a message", and §15.3 step 9's verification checks only the
listed ones. A transfer that honoured the table as written would drop the restore journal, the
in-flight cutover state, the child-attempt receipts, the token-mint receipts, three idempotency
tables and the webhook subscriptions — and the idempotency tables are the ones whose loss is
invisible until an agent retries a key and gets a second message.

**Replacement text**, appended to doc line 1114:

> The two rows above name the tables whose loss is *individually* catastrophic, not the full set.
> There are 37 tables across both stores; the transfer copies every one, and step 7 says so. Two
> groups deserve naming because their loss is silent rather than loud: the four idempotency tables
> (`idempotency`, `read_idempotency`, `topic_idempotency`, `reaction_idempotency`, folded into one
> by base-work item 9), whose loss makes a retried key mint a second message instead of returning
> the first; and the in-flight state tables (`cutover`, `db_restore_requests`, `topic_moves`,
> `topic_page_moves`, `child_attempts`), whose loss makes a transfer taken mid-operation
> unrecoverable — which is why step 1 refuses to run while any of them has a pending row.

---

## 40. IMPRECISE — all three identity-sequence statements in §15.3 step 8 have a defect

**Doc line 1141:**

> Per engine: `SELECT setval(pg_get_serial_sequence('generations','n'), (SELECT MAX(n) FROM generations))` on Postgres, `ALTER TABLE generations AUTO_INCREMENT = <max+1>` on MySQL, and the `sqlite_sequence` row on SQLite. It applies to `generations.n` and `versions.id`, and to any table a future migration gives an identity column.

The framing is right and the last sentence is exactly right: `grep -rn AUTOINCREMENT` returns
precisely two columns, `generations.n` (`packages/boot/src/boot-schema.ts:41`) and `versions.id`
(`packages/boot/src/source-schema.ts:72`). Each statement has a problem.

**Postgres.** `pg_get_serial_sequence` does resolve identity columns despite the name, so pairing
it with §7.2's `GENERATED BY DEFAULT AS IDENTITY` is correct. Two-argument `setval` sets
`is_called` true, so the next value is `MAX(n) + 1` ✓. But on an empty source table `MAX(n)` is
`NULL`, and `setval` is strict, so the call silently returns `NULL` and does nothing. That happens
to be the right outcome, by accident, and it is the kind of accident that stops being right if
anyone later wraps the value in a `COALESCE(MAX(n), 0)` — `setval` to 0 raises
`setval: value 0 is out of bounds for sequence`.

**MySQL.** `ALTER TABLE` accepts no subquery in `AUTO_INCREMENT =`, so `<max+1>` has to be read
back and interpolated by the transfer code. The doc writes the Postgres statement as
self-contained and the MySQL one with a placeholder, which is the right shape, but never says why
they differ, and an implementer is likely to try the subquery first.

**SQLite.** Writing the `sqlite_sequence` row is unnecessary. For an `AUTOINCREMENT` table SQLite
maintains `sqlite_sequence` itself and raises the stored value whenever an insert produces a larger
rowid, explicit rowids included. Copying the rows already leaves it correct.

**Replacement text** for doc line 1141:

> Per engine:
>
> - Postgres: `SELECT setval(pg_get_serial_sequence('generations','n'), MAX(n), true) FROM
>   generations WHERE n IS NOT NULL` — skipped entirely when the table is empty.
>   `pg_get_serial_sequence` resolves identity columns as well as serials, so it is right for
>   section 7.2's `GENERATED BY DEFAULT AS IDENTITY`. Do not `COALESCE` the maximum to 0: `setval`
>   rejects 0 as out of bounds, and on an empty table the sequence is already correct.
> - MySQL: `ALTER TABLE generations AUTO_INCREMENT = <max+1>`, with the value read back and
>   interpolated by the transfer. `ALTER TABLE` accepts no subquery here, which is the one place
>   the three statements cannot share a shape.
> - SQLite: nothing. SQLite maintains `sqlite_sequence` itself for an `AUTOINCREMENT` table and
>   raises it on any insert with a larger explicit rowid, so the row copy already leaves it right.
>   Assert it rather than writing it.
>
> It applies to `generations.n` (`packages/boot/src/boot-schema.ts:41`) and `versions.id`
> (`packages/boot/src/source-schema.ts:72`), which are the only two `AUTOINCREMENT` columns in
> either store today, and to any table a future migration gives an identity column.

---

## 41. IMPRECISE — §15.3 step 5's title says copy the ledger, its body says compare, and copying would violate the primary key step 4 just filled

**Doc line 1138:**

> 5. **Copy the migration ledger, then refuse a mismatch.** The source's `boot_migrations` and `migrations` rows are compared against what step 4 applied. They must agree exactly.

Step 4 immediately before it (doc line 1137) creates the target schema "by running migrations",
which is what writes the ledger: `Migrator` inserts every applied row at `Migrator.ts:264`. So by
step 5 the target ledger is already populated, and `migration_id` is the primary key in all four
of the per-dialect DDL variants (`Migrator.ts:124`, `:133`, `:140`, `:147`). Copying the source's
rows on top raises a unique violation — which `Migrator` itself interprets as `Locked`
(`Migrator.ts:266-270`), so the failure would be reported as "Migrations already running".

The body's "are compared against" is the correct instruction. Only the title is wrong, and it is
the title an implementer skims.

**Replacement text** for the title of step 5:

> 5. **Compare the migration ledgers, and refuse a mismatch.** Never copy them: step 4 has already
>    written the target's ledger, `migration_id` is its primary key, and inserting the source's
>    rows on top raises a unique violation that `Migrator` reports as "Migrations already running".

---

## 42. IMPRECISE — §13 step 3 calls `greatest` a one-site helper, and step 6's file list omits the two files holding four of the divergent sites

**Doc line 936:**

> The three one-site helpers — `greatest`, `distinctFrom`, `tableExists` — are the ones that change meaning silently

Per finding 7, `greatest` has two sites. `distinctFrom` (`packages/boot/src/events.ts:218`) and
`tableExists` (`packages/boot/src/public-pages.ts:67`) are genuinely one each, verified.

**Doc line 976**, step 6's file list, is the practical consequence:

> `db-ops-mysql.ts` (new), `search-index-mysql.ts` (new), `store.ts`, `dialect.ts`, every migration file gaining a `mysql` branch, `agent-roster.ts`, `read-marks.ts`, `event-retention.ts`, `generations.ts`, `auth.ts`, `database.ts`, `app-recovery.ts`, `Dockerfile`, CI config, `mysql-roles.sql` (new), `search-http.ts` …

Two files that must change are absent:

- `packages/server/src/kernel/topic-move.ts` — the second `MAX(reads.seq,excluded.seq)` at `:120`
  (finding 7), plus three `${x}||substr(...)` concatenations at `:116` and `:120` that need
  `CONCAT` on MySQL (finding 18).
- `packages/boot/src/events.ts` — the `distinctFrom` site at `:218`, the `json_each` site at
  `:222`, the `substr(value,-1)` wildcard at `:222` (finding 4), and the `||` concatenation at
  `:128`.

`events.ts` is the more serious omission: it is the only file in the list-of-changes that carries
three separate dialect divergences, and two of them fail silently rather than loudly.

**Replacement text** for the relevant clause of line 936 and the file list at 976:

> The two-site helper `greatest` and the one-site helpers `distinctFrom` and `tableExists` are the
> ones that change meaning silently, so each gets a test asserting the generated SQL per dialect.

and add `packages/boot/src/events.ts` and `packages/server/src/kernel/topic-move.ts` to line 976.

---

## 43. UNVERIFIABLE — whether backtick quoting preserves the `\_` escape in the MySQL wildcard grants

**Doc lines 162 to 164:**

```sql
GRANT ALL PRIVILEGES ON `comms_rehearsal\_%`.* TO 'comms_boot'@'%';
```

and **doc line 171:**

> The escaped `\_` in the pattern matters: unescaped, `_` is a single-character wildcard and the grant would be far wider than intended.

The claim at line 171 is **correct and worth keeping**: MySQL does treat `_` and `%` as wildcards
in the database part of a `GRANT ... ON db.*`, and `\_` is the documented way to match a literal
underscore. Verified against the documented behaviour, and the intent — `comms_app\_%` matches
`comms_app_7` but not `comms_app` itself — is right.

What I could not establish is the interaction with the backticks the script wraps the pattern in.
The pattern is simultaneously an identifier (where a backslash inside backticks is ordinarily a
literal character) and a `LIKE`-style pattern (where the backslash is an escape). I could not find
an authoritative statement of which layer wins here, and the two outcomes are far apart: if the
escape survives, the grant is exactly what the doc intends; if the backticks make the backslash
literal, the grant applies to a database whose name contains a literal backslash, which will never
match anything, and every scratch-database operation fails with an access-denied error that looks
like finding 35.

Marking unverifiable rather than accepting it. It is cheap to settle and expensive to get wrong.

**Replacement text**, appended to doc line 171:

> Confirm the backtick interaction before shipping this file. The pattern is both an identifier and
> a `LIKE`-style pattern, and whether `\_` inside backticks is an escape or a literal backslash
> decides between "exactly the intended grant" and "a grant that matches no database at all". The
> container job in section 12.2 should assert it directly: create `comms_rehearsal_1` as
> `comms_boot`, and assert that creating `comms_rehearsalX1` fails.

---

## Claims I tried to refute and could not

Verified true, with the evidence, so the verifier does not re-walk them.

**Counts against the working tree at `6c21a88`, all exact.** 49 `substr(` occurrences; 408 `sql`
template sites; 39 test files constructing `SqliteClient.layer`; five `RETURNING` statements and
they are the five listed; five `INSERT OR IGNORE` occurrences; one `INSERT OR REPLACE`; 11
composite primary keys; six `SELECT epoch FROM kernel_writer` snapshot reads at exactly the six
cited lines; two `json_each` sites.

**Effect v4 API surface.** `onDialectOrElse` takes `orElse` plus any subset and is synchronous,
returning the branch's value (`Statement.ts:526-533`, implementation at `:608-610`), so the §6.1
wrapper composes into a `sql` template as a `Fragment`. `sql.insert` accepts a record or an array
of records. The `RETURNING`-versus-`OUTPUT` branch is where the doc says (`Statement.ts:994-1005`;
there is a second, unconditional `RETURNING` emission for the insert path at `:938-946`, which
does not change the conclusion). `SqlClient.withTransaction` takes no options (`:57-59`);
`beginTransaction` is fixed per client (`:171`); `transactionService` is public on the interface
(`:64`); a present service means `id >= 1` and `withTransaction` issues a savepoint rather than a
`BEGIN` (`:288`, `:294`); the payload is `readonly [conn, depth]` (`:363`); `Effect.serviceOption`
exists in v4 and is the right accessor (used at `:164`). `Migrator` takes `LOCK TABLE … IN ACCESS
EXCLUSIVE MODE` on Postgres at `:225`, wraps `run` in `sql.withTransaction` at `:308`, and maps
`UniqueViolation`/`ConstraintError` to `Locked` at `:326-327` — §17's correction of the
investigation's `:222` to `:225` is itself correct. `MigratorOptions` is `{ loader,
schemaDirectory?, table? }` at `:29-33`.

**Adapters.** `SqliteClient.layer` has error type `never`. `beginTransaction` is `"BEGIN"` when
`readonly: true` and `"BEGIN IMMEDIATE"` otherwise, at `SqliteClient.ts:238` exactly, with the
module doc making the read-lock consequence explicit at `:7-9` — the load-bearing fact under
§9.2. `PgClientConfig.url` and `.password` are `Redacted.Redacted` (`:81`, `:89`), `types` is a
real option named exactly that (`:101`) and is threaded to the connection (`PgConnection.ts:243`),
`applicationName` exists (`:95`), `PgClient.layer` is `Layer<…, SqlError>` (`:347-349`). MySQL
binds `?` (`MysqlClient.ts:464-466`) and Postgres `$n` (`PgClient.ts:367-369`) and pglite the same
(`PgliteClient.ts:411-415`), so the §11 placeholder-style check is well founded.
`PgliteClient.layer()` takes an optional config and returns
`Layer<PgliteClient | SqlClient, SqlError>` at `:393-395` with `dialect: "pg"`, so the §6.1
wrapper's pg branch does fire for pglite and the whole dialect suite can run without Docker.
`PgMigrator` shells `pg_dump` through `ChildProcess.make` plus `spawner.string` at `:48-64` (not
`Command.make`), and `MysqlMigrator.ts:36-87` is a commented-out v3 `Command` block — §17's
correction stands. `SqliteMigrator` likewise has no dump.

**Test harness.** `vitest.config.ts:11` is `EFFECT_INTEGRATION_TESTS === "1"` verbatim, `:51`
excludes `**/*.integration.test.{ts,tsx}` verbatim, and the MySQL-competes-for-runners comment is
at `:178-184` verbatim. `pg/test/utils.ts` builds `PgContainer` with `Effect.acquireRelease` and
exposes `layerClient` as `PgClient.layer({ url: Redacted.make(container.getConnectionUri()) })`;
`mysql2/test/utils.ts:21-44` mirrors it.

**Current code.** `read-marks.ts:72` is quoted exactly. `app-backup.ts:20-26` is the clone,
`:42-46` the ceiling query, `:49-59` the restore, and the comment at `:55` reads exactly as
quoted. `public-pages.ts:67` is the `sqlite_master` probe. `boot-schema.ts:33` is `version > 13`
and `:83` stamps 13; `:34` sets `journal_mode` after the check, which is why `disableWAL: true` is
right on every boot connection. `supervisor.ts:86-92` is the `launch` signature and `:112-124`
the explicit child environment with `APP_DATABASE: filename` at `:117` — R3's mechanism is exactly
as described. `boot-channel.ts:52` reads `APP_DATABASE`, `:93` already uses `Config.Redacted` for
`BOOT_SECRET`, `:106` is the 1500 ms bound, `:140-142` is the `Context.Service` form, and `:55-91`
is the rehearsal branch that never reads `BOOT_URL` or `BOOT_SECRET`. `server.ts:213` and
`sql-read.ts:71` are the two `SqliteClient.layer` call sites quoted correctly, including
`busyTimeout: "100 millis"`. `sql-read.ts:33` is the `^(SELECT|WITH)` plus separator ban and `:37`
the unaliased `LIMIT 201` wrapper. `database.ts:5-9` is the fence, `:7` the conditional update,
`:18` the too-new check, `:59-63` the FTS table joined on `rowid` with `message_id UNINDEXED`,
`:80` the shape probe, `:33` `messages.id TEXT PRIMARY KEY`. `published-messages.ts:4-5` is the
snapshot comment verbatim and `:6-15` the five `CASE` columns. `event-retention.ts:26-46` already
has the select-before-delete shape. `edit-lock.ts:233` supplies all ten `edit_lock` columns
(schema at `boot-schema.ts:52-58`), so the upsert rewrite is behaviour-preserving as claimed.
`source-schema.ts:70` is the partial unique index verbatim. `enrollment-schema.ts:30` is
`family TEXT NOT NULL UNIQUE`, so the first `GROUP BY` branch's uniqueness argument holds.
`refresh-schema.ts:7` is `/^f_[A-Za-z0-9_-]{43}$/`. `migrations.ts:45`, `:47`, `:48` are the outer
transaction, the epoch gate and `Migrator.make({})({ loader, table: "migrations" })`.
`migrations/README.md:3` promises "a default-exported Effect requiring only `SqlClient`".
`agent-roster.ts:15-23` does select bare columns under a `GROUP BY e.family`.
`account-queries.ts:56-62` does use `MIN()` for the same shape. `backup-drill.ts` was deleted in
`c6f2a14` (`git log --diff-filter=D`), as §17 says. `Statement.ts:473-491` carries the
"Not supported in sqlite" note on `updateValues`, and `MysqlClient`'s compiler does stub
`onRecordUpdate`, so §14.4 item 7 is right on both engines.

**SQL semantics.** MySQL's `->>` on a JSON `null` yields the four-character string `null`, and
`CAST('null' AS SIGNED)` is `0`, so §6.3's `NULLIF` rule and its stated consequence for
`deleted_at IS NULL` are both right. Postgres `->>` and SQLite `json_extract` both yield SQL
`NULL`. `to_tsvector(regconfig, text)` with a literal config is `IMMUTABLE` and the one-argument
form is not, so §8.2's generated columns are legal exactly as written, and `websearch_to_tsquery`
is total on arbitrary input. `unaccent` has been a trusted extension since PG 13.
`innodb_ft_min_token_size` defaults to 3. MySQL unique indexes ignore `NULL`, so the generated
`publishing_singleton` column is a faithful substitute for the partial index, and MySQL indexes
`STORED` generated columns including with `FULLTEXT`. `INSERT … AS new` needs 8.0.19+ and the
default compiler emits `(cols) VALUES (…)`, so the alias lands in the right position. Postgres and
MySQL both require a derived-table alias and SQLite tolerates one. `IS NOT` / `IS DISTINCT FROM` /
`NOT (a <=> b)` is the correct null-safe mapping. Postgres does not optimise away `SET
epoch=epoch`; it takes the lock and writes a new tuple version. `FOR SHARE` exists on MySQL 8.0.1+
and takes an S lock that a concurrent `UPDATE` blocks on, so the §9.2 prelude does what it claims
on both remote engines. `starts_with` is `IMMUTABLE` and gained btree planner support in PG 15,
so §6.2's index remark holds for PG 15+ with `text_pattern_ops` (worth pinning the version, but
the claim is not false).

**The collation finding I came in expecting.** I had MySQL's default `utf8mb4_0900_ai_ci`
silently merging case-distinct token families, message ids and topic paths as a top finding. The
current §3.3 at lines 149 to 150 and 169 sets `utf8mb4_0900_as_cs` on both databases, names the
base64url token-hash collision specifically, §14.4 item 5 makes it a required startup assertion,
and §12.3 item 6 gives it a container test. That is a complete answer; only the assertion's
granularity is off, which is finding 33. The stakes are as stated: `tokens.hash` is
`TEXT NOT NULL UNIQUE` (`packages/boot/src/enrollment-schema.ts:35`) and token families are
base64url (`packages/boot/src/refresh-schema.ts:7`), so a case-insensitive collation really would
merge two distinct hashes on that index.

### Second pass, additionally verified

**§14.4 item 1 is right, and it is the best finding in the document.** `Migrator` inserts the
whole pending batch's ledger rows at `Migrator.ts:262-274` and only then runs the migration
effects at `:276-286`, so on MySQL — where the first DDL statement implicitly commits — the ledger
does claim all five applied while the schema stopped at three. I went looking for an error in the
ordering claim and the line numbers, and both are exact. The reasoning about the outer
transaction's epoch gate committing with it (doc line 1045) follows correctly from
`migrations.ts:45` and `:47`.

**§14.4 item 4's compensation exists.** `packages/server/src/kernel/database.ts:27-29` does select
from the recovery tables at child start, so a generation that dropped one fails health before
serving, and `app-recovery.ts:39-41` does recreate them. The claim that `comms_app` can drop
`kernel_writer` on MySQL follows from the script's own `GRANT ALL PRIVILEGES ON comms_app.*` at
doc line 153.

**§14.4 item 7.** `Statement.ts:473-491` carries the "Not supported in sqlite" note on
`updateValues` at `:483`, and `grep -rn updateValues packages/` confirms comms does not use it.

**§15's premise and most of its procedure.** `pg_dump` cannot read a SQLite file and `sqlite3
.dump` emits SQL Postgres rejects, so the "comms' own transfer" conclusion stands.
`packages/boot/src/recovery-intents.ts` exists and `packages/boot/src/database-restore.ts:208-210`
is the refusal pattern step 1 cites, verbatim. `supervisor.assertClosure` is the right check for
step 2 and is already used at five sites. `AppRecovery.prepare` for step 10 exists at
`app-recovery.ts:26` and installs a fresh epoch at `:44`. `tokens.hash` exists for step 9's
content hash (`enrollment-schema.ts:35`). Step 7's "foreign keys are not declared in comms'
schema" is nearly right — `source_changes.batch` and `versions.batch` do carry
`REFERENCES source_batches(id)` (`source-schema.ts:71-72`) — but SQLite does not enforce them
without `PRAGMA foreign_keys=ON`, which comms never sets, while Postgres and MySQL enforce them
always. So ordering is about constraint satisfaction on the target after all, at least for those
two tables. Worth a clause; not large enough to number separately.

**§15.4's search-index claim.** Rebuilt rather than copied is right on all three: the SQLite
triggers at §8.1 fire `AFTER INSERT ON messages` and so repopulate during the row copy, Postgres's
generated `tsvector` columns populate on insert, and MySQL's generated `previous_body` column and
`FULLTEXT` indexes update on insert.

**§12.3's six tests are the right six** and each names a mechanism that genuinely needs a real
server. Item 1's added MySQL clause — that it also proves the select-after-write reads under the
lock the `UPDATE` took — is the correct thing to assert there, though finding 5 means the statement
under test has to change first.

**§3.3's MySQL grant structure**, apart from findings 32, 35 and 43. `GRANT ALL PRIVILEGES` on a
database-name pattern does permit `CREATE DATABASE` of a matching name, so the scratch-database
mechanism works in principle; `comms_app\_%` correctly excludes `comms_app` itself; and the claim
that MySQL has no `PUBLIC` pseudo-role to revoke from is right.

**§2's new rules** contain no factual claim I could test beyond R4b, whose procedure is §15 and is
covered above.
