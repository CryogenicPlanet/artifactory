# One database engine per deployment: the design

Status: design, not yet implemented. Sequenced after the PR #1 base work (`docs/pr-1/pr-comments.md` items 1 to 22), as its own PR. The investigation this grows out of is `docs/pr-1/database-interoperability.md`; this document decides what gets built, names every API against the vendored Effect v4 rc under `repos/effect/` (`@effect/sql-*` at `4.0.0-rc.113`), and cites current code by `file:line`.

Every Effect API name below was re-checked against the vendored source. Where the investigation named something that does not exist or sits at a different line, section 17 lists the correction. This revision was verified against the two adversarial reviews in `docs/pr-1/db-doc-review-a.md` and `db-doc-review-b.md`; the verification log is `docs/pr-1/db-doc-verification.md`.

**Which code the citations point at.** The committed head is `6c21a88`, and the working tree carries the uncommitted base work on top of it (158 files changed on 2026-09-11). Every `packages/` citation below is against that working tree as read on 2026-09-11, because it is the closest thing to the code this design lands on. Line numbers will drift again before implementation; the constructs will not. Where the base work has already removed a site this document once cited, the text says so rather than pretending the site is still there.

---

## 1. Purpose and status

### 1.1 What this decides

Both comms stores run on one pluggable engine, and a deployment picks SQLite, Postgres or MySQL. All three ship, all three are tested, and everything works after the swap. SQLite on a volume stays the default and the reference implementation; Postgres is the first remote engine built; MySQL is the second, and it is a required step rather than an optional one. The decision itself is already fixed in `SPEC.md` §12 (the bullets dated 2026-09-10) and `docs/tech.md` §4; this document turns those bullets into a buildable design:

- the store descriptor that replaces `APP_DATABASE`, and the one parser behind it;
- `DbOps`, the service that owns every operation that is not a SQL statement;
- `dialect.ts`, the fragment helpers that own every statement whose text differs per engine;
- both `user_version` ladders becoming `Migrator` modules, and the one-time adopt step;
- a `Search` service with three index implementations behind one public contract;
- the concurrency rules that keep the writer-epoch fence, the boot singletons and the read snapshot correct off SQLite;
- backups, restore, drills and budgets per engine, and the durable identity of the live app store;
- the read-only SQL route's dialect reporting;
- what it takes to move a live board from one engine to another (section 15), including the markers that make an interrupted or superseded transfer detectable;
- testing, a step-by-step migration plan, and an honest account of what weakens.

The "all three shipped" wording is already in place: `SPEC.md` §12's one-engine bullet says "All three are shipped and tested", `docs/tech.md` §4's backend table says "Shipped and tested" for `mysql://`, and `docs/tech.md` §12's third bullet matches. What is still stale in `docs/tech.md` §4 is listed under step 0 in section 13.

### 1.2 Sequencing

This is its own PR after the base work. Nothing here should be started while items 1 to 22 are open, for the reason `pr-comments.md` item 23 gives: the base work moves and deletes a large fraction of the files this touches. Several examples have already landed in the working tree. `packages/boot/src/backup-drill.ts` was deleted in commit `c6f2a14`, so the weekly drill is an app concern calling boot mechanisms, and section 10.4 is written that way. `packages/boot/src/agent-roster.ts` is deleted, so the `GROUP BY` problem the investigation found there is gone with it. The publication fence is cached in the child (`packages/server/src/kernel/boot-channel.ts:164-178`, item 10), which section 9.2 relies on. `public_paths` is a boot-store table (`packages/boot/src/boot-schema.ts:86`, `packages/boot/src/public-paths.ts:21`), projected by boot's own append transaction (`packages/boot/src/events.ts:150`), so boot no longer reads any app table. The boot schema is at version 14 (`boot-schema.ts:34`, stamped at `:88`) and the app schema at version 7 (`packages/server/src/kernel/database.ts:20`, stamped at `:79`).

### 1.3 The two habits that apply immediately

These cost nothing and are in force now, before any of the work below starts.

1. **No new SQLite-only construct where the portable form is the same length.** Write `ON CONFLICT (...) DO UPDATE` rather than `INSERT OR REPLACE`; write `GREATEST(a, b)` rather than two-argument `MAX(a, b)`. One site still violates the second: `packages/server/src/kernel/topic-move.ts:126` does `DO UPDATE SET seq=MAX(reads.seq,excluded.seq)` (the `read-marks.ts` site the investigation named has since been rewritten to a portable `WHERE reads.seq<excluded.seq`). Two-argument `MAX` is a scalar function in SQLite only: Postgres rejects it (`function max(integer, integer) does not exist`, and it forbids aggregates in an `UPDATE … SET` list anyway) and MySQL rejects it (`ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT`). It is a loud failure on both remote engines, which makes it cheap to catch but easy to leave until the port; fix it now anyway, because `GREATEST` costs the same to write. The base work has meanwhile added three more SQLite-only constructs that the habit is supposed to prevent: `topic GLOB` and `type GLOB` filters (`packages/boot/src/events.ts:242`, `:245`, `:254`) and the `NOT INDEXED` / `INDEXED BY` planner hints (`events.ts:272-273`). Section 6.7b covers them; do not add more.
2. **Boot never learns an app table name.** Enforced in CI by `grep -E 'FROM (topics|messages|reads|agents)' packages/boot/src`, which must be empty. It is empty at the working tree: base-work item 21 removed the `MAX(seq) FROM messages` ceiling query from `app-backup.ts` and the `topics` reads from `public-pages.ts`, which now reads only the boot-owned `public_paths` table (`packages/boot/src/public-pages.ts:40`). Keep it empty.

---

## 2. Decisions, restated as rules

An implementer can check every choice below against these. They restate the `SPEC.md` §12 bullets dated 2026-09-10 and `docs/tech.md` §12, plus three rules the adversarial reviews forced (R13 to R15).

| # | Rule |
| --- | --- |
| R1 | One engine per deployment, for both stores. Unset database URLs mean SQLite files under `/data`. Setting them moves both stores onto one Postgres or one MySQL server. A deployment never mixes engines, never puts one store on a different engine from the other, and never puts the two stores on different servers: the two URLs must agree on scheme, host and port or startup fails with `store_engine_mismatch`. |
| R2 | Two databases, two roles. Boot's role owns the boot database; the app's role owns the app database and has no grant on boot's. Boot's role is a member of the app's role, which is how boot reads, backs up, clones and restores the app database without ever holding the app's credential (section 3.2). Setting only one of `DATABASE_URL` and `BOOT_DATABASE_URL` is a configuration error that refuses startup. |
| R3 | The app's credential reaches each child in its explicit per-attempt environment map. Boot's credential is never placed in that map, and never appears in a stderr tail, a failure body or a `generations` row (section 4.2). |
| R4 | All three engines ship and all three are tested. SQLite is the default and the reference implementation; Postgres is built second, MySQL third. Order of work is not order of support: a deployment on any of the three is a supported deployment, and a test suite that passes on one must pass on all three. |
| R4a | Where an engine cannot express a construct the reference implementation uses, the substitute is named, implemented and tested, and the guarantee it weakens is written down with its compensation. Section 14.4 is that list for MySQL, and it is part of the definition of done rather than a postscript. |
| R4b | A deployment can move from one engine to another without losing a `seq`, an event, a token or a message, **provided every agent-authored migration has a branch for the target dialect**. Section 15 is the procedure and section 15.6 states the condition. |
| R5 | Every file-shaped guarantee has a named engine-neutral form, owned by one service. Nothing in boot outside that service knows whether the store is a file. |
| R6 | Rehearsal always runs a real candidate process with the full self-test against a real copy of the data. Never a rolled-back in-process migration, never an empty schema, never a sample. |
| R7 | Rehearsal's deadline is configuration. Exceeding it fails the edit with the distinct code `rehearsal_copy_timeout`, not with a generic rehearsal failure. |
| R8 | Positive closure evidence from the child keeper is required before any restore, on every engine. An orphaned writer committing into an abandoned store loses acknowledged writes however the store is addressed. |
| R9 | Store capacity is reported as unknown, never guessed, when the engine is remote. The volume's own budgets for snapshots and dump artefacts are unchanged; the budgets for rows that move off the volume are restated in section 10.6. |
| R10 | The transactional outbox stays on every engine. The `SECURITY DEFINER` shortcut that a shared engine would permit is rejected (section 9.5). |
| R11 | With a remote engine, `/_boot/*` depends on that engine being reachable. That is the durability tradeoff the deployment chooses on purpose, and it is stated in `SPEC.md` §9. |
| R12 | Boot knows no app domain table name, on any engine. The CI grep from R-habit 2 is part of the definition of done for every step below. |
| R13 | On a remote engine the live app store's database name is boot state, journaled in the boot store, not configuration. A restore that lands in a fresh database writes the new name in the same boot transaction that records the restore, and boot starts from the journal, never from the URL's path, once the store has been initialised (section 10.3). |
| R14 | Every boot transaction that reads a singleton row and writes a value computed from it takes that row exclusively first. On SQLite `BEGIN IMMEDIATE` does this for free; on Postgres and MySQL it is an explicit `FOR UPDATE` (section 9.3). |
| R15 | A transfer is detectable from the stores alone: the target carries an in-progress marker until verification passes, and the source is stamped as transferred on success. Boot refuses to start on either (section 15.4). |

---

## 3. Deployment shapes

### 3.1 SQLite on a volume (default)

```
DATA_DIR=/data            # boot store /data/boot.db, app store /data/comms.db
# DATABASE_URL unset
# BOOT_DATABASE_URL unset
```

The child receives `APP_STORE=file:/data/comms.db`. Nothing else changes: the file ownership split in `SPEC.md` §7.9 stays exactly as it is, and `disableWAL: true` remains set on every boot-side connection because `packages/boot/src/boot-schema.ts:35` sets `journal_mode` itself after the version check at `:34`, and `journal_mode` is not transactional.

### 3.2 One Postgres server, two databases, two roles

```
DATABASE_URL=postgres://comms_app:…@db:5432/comms_app
BOOT_DATABASE_URL=postgres://comms_boot:…@db:5432/comms_boot
```

Both point at the same server (R1 checks it). Different dbnames, different roles, different passwords. The child receives `APP_STORE` built from `DATABASE_URL`'s credential and the journaled database name (R13), and never sees `BOOT_DATABASE_URL`, because the child environment is built as an explicit map at `packages/boot/src/supervisor.ts:112-124` and spawned with exactly that map; nothing is inherited from boot's own environment. That property is what makes R3 true today with paths, and it is what keeps R3 true with credentials.

**Boot reaches the app database as `comms_boot`, never as `comms_app`.** There are three descriptors in play and only two environment variables. `DATABASE_URL` is the app's descriptor and the only one a child sees. `BOOT_DATABASE_URL` is boot's own store. The third, boot's view of the app database, is derived rather than configured: `BOOT_DATABASE_URL`'s scheme, host, port and credential with the app database's name as the path. `Store.asBoot(appStore, bootStore)` in section 4.2 builds it, and it is what `DbOps`, `AppRecovery` and every `pg_dump` run against. This is the reason R1 requires one server: the derivation only makes sense if boot's credential is valid on the server that holds the app database.

The grant script is a checked-in file, `packages/boot/sql/postgres-roles.sql`, so the boundary is reviewable rather than folklore. It is run once by the operator against a fresh server, with `psql -v` variables for the two passwords.

```sql
-- packages/boot/sql/postgres-roles.sql
-- Run once, as a superuser, against a fresh server. comms never runs this itself.

CREATE ROLE comms_boot LOGIN PASSWORD :'boot_password'
  NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE comms_app  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Boot is a member of the app role. Membership (INHERIT is the default) gives
-- comms_boot the app role's privileges on everything comms_app owns, lets it
-- CREATE DATABASE ... OWNER comms_app, ALTER ... OWNER TO comms_app during a
-- restore, and terminate comms_app's backends. The app role is not a member of
-- boot's, so the boundary is one-directional.
GRANT comms_app TO comms_boot;

CREATE DATABASE comms_boot OWNER comms_boot;
CREATE DATABASE comms_app  OWNER comms_app;

REVOKE CONNECT ON DATABASE comms_boot FROM PUBLIC;
REVOKE CONNECT ON DATABASE comms_app  FROM PUBLIC;
GRANT  CONNECT ON DATABASE comms_boot TO comms_boot;
GRANT  CONNECT ON DATABASE comms_app  TO comms_app, comms_boot;

\connect comms_app
REVOKE ALL   ON SCHEMA public FROM PUBLIC;
GRANT  USAGE, CREATE ON SCHEMA public TO comms_app;
-- comms_boot needs no grant of its own here: through membership it holds
-- comms_app's privileges, which is how it creates the four boot-owned tables
-- (section 3.5) and how pg_dump reads every table an agent adds later.

\connect comms_boot
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT  USAGE, CREATE ON SCHEMA public TO comms_boot;
```

Five notes on this script.

**The app role must not be `SUPERUSER` and must not have `CREATEDB`.** If it has either, the rehearsal and restore isolation is decorative: an app-side migration could reach into the boot database or into a scratch clone. `NOSUPERUSER NOCREATEDB` on `comms_app` is the load-bearing half of the whole boundary. The boot role is the asymmetric half: it needs `CREATEDB` because `cloneForRehearsal`, `restoreInto`, `dropClone` and `reapClones` all create or drop databases, and Postgres has no way to scope `CREATEDB` to a name pattern the way the MySQL script does with `comms_rehearsal\_%`. The boot role's database-creation right is therefore unscoped, and the boundary rests on the app role not having it.

**Membership replaces per-table grants in the boot direction.** Postgres treats a member of the owning role as the owner for permission checks, so `comms_boot` can read, dump and `ALTER` anything `comms_app` owns without a `GRANT`, and an agent-authored migration cannot revoke that access because there is no grant to revoke. This is stronger than `ALTER DEFAULT PRIVILEGES`, which an agent could undo. The rule the script relies on: a non-superuser may create a database owned by another role, or change an object's owner to another role, only if it is a member of that role; and `pg_terminate_backend` may signal another role's backend if the caller is a member of that role. All three follow from the one `GRANT comms_app TO comms_boot`.

**Table-level grants run in a migration, not in this script, and only in the app direction.** The boot-owned tables in the app database do not exist until boot creates them. Boot creates `kernel_writer`, `mutation_batches` and `outbox` today at `packages/boot/src/app-recovery.ts:39-41` and seeds the fence at `:42`, inside the app store; section 3.5 adds `store_identity`. Boot connects as `comms_boot`, so those tables are owned by `comms_boot`, and the app needs a grant on them, not the other way round. The grants are issued by boot immediately after it creates the tables, in the same transaction:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel_writer, mutation_batches, outbox TO comms_app;
GRANT SELECT ON store_identity TO comms_app;
```

Boot owning these tables is stronger than the SQLite arrangement, not weaker: on Postgres only the owner (or a member of the owning role, which `comms_app` is not) can `DROP` or `ALTER` them, so an app-side migration cannot remove the tables boot recovers from. On SQLite it can.

**Every database boot creates later needs the same three statements this script ran by hand.** A new database inherits `CONNECT` for `PUBLIC` from the default ACL, not from this script, and on Postgres 15 and later its `public` schema is owned by `pg_database_owner`. So `cloneForRehearsal` and `restoreInto` run, at creation time and not at drop time: `REVOKE CONNECT ON DATABASE <new> FROM PUBLIC`, `GRANT CONNECT ON DATABASE <new> TO comms_app, comms_boot`, and after the load, `GRANT USAGE, CREATE ON SCHEMA public TO comms_app` if the dump did not carry it. The rehearsal child connects to the clone as `comms_app` (R3), so revoking it is wrong; what the revoke removes is every other role on a shared server.

**Ownership after a clone or restore.** Backups are taken with `pg_dump -Fc` *with* owners and privileges (section 5.2), and `pg_restore` runs as `comms_boot`, which re-issues `ALTER TABLE … OWNER TO comms_app` for the app's tables and keeps the four boot-owned tables under `comms_boot`; membership makes both legal. Clones and restore targets are created `OWNER comms_app` so that `pg_database_owner`, and with it the `public` schema and trusted-extension creation (section 8.2), behave exactly as they do on the live database. A rehearsal against a clone whose ownership differs from the live store would rehearse the wrong thing. The container test in section 12.3 item 7 asserts that a rehearsal child can write the clone and that `pg_dump` as `comms_boot` reads an agent-added table.

### 3.3 One MySQL server, two databases, two users

```
DATABASE_URL=mysql://comms_app:…@db:3306/comms_app
BOOT_DATABASE_URL=mysql://comms_boot:…@db:3306/comms_boot
```

MySQL has no schema concept distinct from database, so "two databases" is the only shape that reads the same on both remote engines. `docs/tech.md` §4's older "separate schemas (`boot`, `app`)" phrasing is Postgres-shaped and does not survive MySQL; it is already superseded there. Boot's view of the app database is derived exactly as on Postgres: `comms_boot`'s credential, `comms_app`'s database name.

The grant script is `packages/boot/sql/mysql-roles.sql`, the same structure as the Postgres one. MySQL has no `PUBLIC` pseudo-role to revoke from, so the boundary is "grant nothing" rather than "revoke the default", which is simpler to write and easier to get wrong by omission. The `mysql` client has no parameter binding for a script, so the two passwords are supplied as `mysql` user variables from the operator's shell (`mysql --init-command="SET @boot_password='…', @app_password='…'"` or the equivalent from a file), never as `-p` arguments; `CREATE USER … IDENTIFIED BY` does not accept a variable directly, so the script builds the two statements with `PREPARE … FROM CONCAT(…)` and `EXECUTE`. That is uglier than `psql -v` and it is the honest mechanism.

```sql
-- packages/boot/sql/mysql-roles.sql
-- Run once, as root, against a fresh server, with @boot_password and @app_password
-- set by --init-command. comms never runs this itself.

SET @create_boot = CONCAT('CREATE USER ''comms_boot''@''%'' IDENTIFIED BY ', QUOTE(@boot_password));
SET @create_app  = CONCAT('CREATE USER ''comms_app''@''%''  IDENTIFIED BY ', QUOTE(@app_password));
PREPARE s FROM @create_boot; EXECUTE s; DEALLOCATE PREPARE s;
PREPARE s FROM @create_app;  EXECUTE s; DEALLOCATE PREPARE s;

CREATE DATABASE comms_boot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
CREATE DATABASE comms_app  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

GRANT ALL PRIVILEGES ON comms_boot.* TO 'comms_boot'@'%';
GRANT ALL PRIVILEGES ON comms_app.*  TO 'comms_app'@'%';

-- Boot creates and owns four tables inside the app database (section 3.5), reads
-- every table for mysqldump, and rebuilds the schema on restore.
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE, REFERENCES,
      SHOW VIEW, TRIGGER, LOCK TABLES
  ON comms_app.* TO 'comms_boot'@'%';

-- Rehearsal, drill and restore targets. comms_boot creates and drops these; the
-- rehearsal child connects to a clone as comms_app, so comms_app gets the same
-- data privileges on the scratch patterns and nothing else.
GRANT ALL PRIVILEGES ON `comms_rehearsal\_%`.* TO 'comms_boot'@'%';
GRANT ALL PRIVILEGES ON `comms_drill\_%`.*     TO 'comms_boot'@'%';
GRANT ALL PRIVILEGES ON `comms_app\_%`.*       TO 'comms_boot'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES
  ON `comms_rehearsal\_%`.* TO 'comms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES
  ON `comms_drill\_%`.*     TO 'comms_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES
  ON `comms_app\_%`.*       TO 'comms_app'@'%';
```

Four differences from the Postgres script matter.

**A case- and accent-sensitive collation is required.** MySQL's default `utf8mb4_0900_ai_ci` is case-insensitive and accent-insensitive, which would make `messages.id`, topic paths, token hashes and idempotency keys compare equal when they are not. A base64url token hash differing only in case would collide on a `UNIQUE` index. Set `utf8mb4_0900_as_cs` on both databases and never rely on the server default. The startup assertion in section 14.4 item 5 checks the columns, not the database default.

**The boot user needs the wildcard grants for scratch databases, and so does the app user.** MySQL has no per-database ownership, so "boot may create and drop scratch databases, the app may not" is expressed as a grant on a name pattern rather than as ownership. The app user needs data and DDL privileges on the same patterns because the rehearsal child runs migrations against a clone as `comms_app` (R3); what it does not get is the ability to create a database. The escaped `\_` in the pattern matters: unescaped, `_` is a single-character wildcard and the grant would be far wider than intended. The backslash survives the backticks: the MySQL reference manual's own `GRANT` example is `` GRANT ... ON `foo\_bar`.* ``, so the escape is read at the pattern layer, not the identifier layer. Section 12.3 item 12 pins it anyway, because the two outcomes are far apart.

**`mysqldump` needs more than `SELECT`, and one thing it wants cannot be granted.** `SHOW VIEW` and `TRIGGER` are required to dump views and triggers an agent may add, and `LOCK TABLES` is required unless every dump runs with `--single-transaction`, which comms does (section 5.2). They are in the grant so that a dump never fails on an object type the schema did not have yesterday. What is deliberately not in the grant is `PROCESS`: MySQL 8.0.21 and later `mysqldump` asks for it to emit tablespace statements, it exists only at `*.*`, and granting it would let `comms_boot` see every statement every connection on the server is running, which is far wider than the two-database boundary. Every `mysqldump` comms runs therefore passes `--no-tablespaces` (section 5.2), and the container job asserts that a dump succeeds under exactly this grant.

**There is no MySQL equivalent of Postgres ownership protecting boot's tables.** On Postgres, only the owner may `DROP` the boot-owned tables, so an app-side migration cannot remove them (section 3.2). On MySQL, `comms_app` has `DROP` on `comms_app.*` and can therefore drop `kernel_writer`. That is a real weakening, and section 14.4 records it with its compensation.

### 3.4 One database, two schemas: not supported

Some managed providers hand you exactly one database. That shape is **not supported**, and the reason is mechanical. The client side could be made to work without any adapter change: `ALTER ROLE comms_app SET search_path = comms` and `ALTER ROLE comms_boot SET search_path = boot` in the grant script would route every unqualified identifier to the right schema, because a role's `search_path` setting applies to every session that role opens, and `PgClientConfig` (`repos/effect/packages/sql/pg/src/PgClient.ts:80-123`) needs no `searchPath` option for that. What does not work is everything in `DbOps`. Rehearsal, drills and restore all need a database to load a dump into (section 5.2), and `pg_dump --schema=comms | pg_restore` cannot be pointed at a *different* schema name without rewriting the dump, so a one-database deployment would need a schema-renaming clone path that has no equivalent on MySQL and no equivalent in the vendored tools. That is a second `DbOps` implementation, not a configuration flag.

Until someone needs it badly enough to write that implementation, R2's two databases are a hard requirement, and `?schema=` is not part of the descriptor grammar in section 4.1.

### 3.5 The four boot-owned tables in the app database

Boot creates exactly four tables in the app store, on every engine, and the app gets grants on them rather than the other way round:

| Table | Purpose | Today |
| --- | --- | --- |
| `kernel_writer` | the writer-epoch fence | `packages/boot/src/app-recovery.ts:39` |
| `mutation_batches` | the batch receipt recovery reads | `:40` |
| `outbox` | the transactional outbox | `:41` |
| `store_identity` | the store's identity and transfer stamp (section 10.3, 15.4) | new |

`public_paths` is **not** one of them: it lives in the boot store (`packages/boot/src/boot-schema.ts:86`) and is projected there by boot's own append transaction. The investigation and an earlier revision of this document placed it in the app database; that was wrong at the working tree and would have put an app-readable table under boot's credential.

`store_identity` is one row: `(singleton, store_id, initialized_at, transferred_to)`. `store_id` is a UUID minted when boot initialises the store and mirrored into the boot store's `settings` under `app_store_id`. It is what "the app store exists and is the one the marker refers to" means on an engine where `fs.exists` (`app-recovery.ts:29`) has no meaning, and section 10.3 specifies how `prepare` uses it.

---

## 4. The store descriptor

### 4.1 Grammar

One opaque string, parsed in exactly one place, that names an engine and a database.

```
file:/data/comms.db
file:/data/gen/13/rehearsal.db
postgres://app:secret@db:5432/comms_app
postgres://app:secret@db:5432/comms_rehearsal_13
mysql://app:secret@db:3306/comms_app
```

Rules:

- Scheme is `file`, `postgres` (alias `postgresql`), or `mysql`. Anything else is `store_descriptor_invalid`.
- `file:` takes a single-slash absolute path with each segment percent-encoded, so that `?`, `#` and `%` in a filename are filename characters and never connection options; `file://` and `file:///` are rejected. No query string, no host. (Deliberately not RFC 8089; pinned by PR #2's parser tests.)
- `postgres:` and `mysql:` require a non-empty path segment, which is the database name. A missing database name is an error rather than a default, because "connect to whatever database the role defaults to" is exactly the ambiguity the two-database shape exists to remove.
- Any query parameter is rejected. Connection tuning is not part of the descriptor, and the `?schema=` parameter an earlier revision accepted is gone with section 3.4. Note that the pg URL parser ignores unknown query parameters silently (`repos/effect/packages/sql/pg/src/PgConnection.ts:2281`, "Unknown query parameters are ignored, matching libpq"), so the rejection has to happen in comms' parser or it does not happen at all.

### 4.2 The one parser

`packages/storage/src/store.ts` (see 4.3 for why it is its own workspace) exports the parser, the descriptor type, the two derivations, and the client-layer factory.

```ts
// packages/boot/src/store.ts
import { Config, Data, Effect, Layer, Redacted, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

export type StoreDescriptor =
  | { readonly _tag: "file"; readonly filename: string }
  | { readonly _tag: "postgres"; readonly url: Redacted.Redacted; readonly database: string }
  | { readonly _tag: "mysql"; readonly url: Redacted.Redacted; readonly database: string };

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  code: Schema.Literals([
    "store_descriptor_invalid",
    "store_engine_mismatch",
    "store_engine_unsupported",
    "store_unreachable",
    "store_transferred",
    "store_transfer_incomplete",
    "store_isolation_unsupported",
    "store_collation_unsupported",
  ]),
  detail: Schema.optionalKey(Schema.String),
}) {}

export const parse: (raw: string) => Effect.Effect<StoreDescriptor, StoreError>;

/** Dialect of a descriptor, without opening a connection. */
export const dialectOf: (store: StoreDescriptor) => "sqlite" | "pg" | "mysql";

/** The same server and credential, a different database. Used for clones and restore targets. */
export const withDatabase: (store: StoreDescriptor, database: string) => StoreDescriptor;

/** Boot's view of an app-side database: boot's server and credential, the app database's name.
 *  Fails store_engine_mismatch unless both descriptors share scheme, host and port (R1). */
export const asBoot: (app: StoreDescriptor, boot: StoreDescriptor) => Effect.Effect<StoreDescriptor, StoreError>;

/** Render for the child environment. Never logged; the URL carries a credential. */
export const render: (store: StoreDescriptor) => Redacted.Redacted;

/** Rewrite scheme://user:password@host to scheme://[redacted]@host in any text. */
export const redactUrls: (text: string) => string;

export const clientLayer: (
  store: StoreDescriptor,
  options?: { readonly readonly?: boolean; readonly busyTimeout?: Duration.Input },
) => Layer.Layer<SqlClient.SqlClient, SqlError.SqlError | Config.ConfigError>;
```

`clientLayer` branches on the tag:

| Tag | Layer | Verified at |
| --- | --- | --- |
| `file` | `SqliteClient.layer({ filename, disableWAL: true, readonly?, busyTimeout? })` | `repos/effect/packages/sql/sqlite-bun/src/SqliteClient.ts:285-293`, config interface at `:89-106` |
| `postgres` | `PgClient.layer({ url, types: intCodecRegistry, applicationName })` | `repos/effect/packages/sql/pg/src/PgClient.ts:347-349`, config at `:80-123` |
| `mysql` | `MysqlClient.layer({ url })` | `repos/effect/packages/sql/mysql2/src/MysqlClient.ts:445-447`, config at `:182-209` |

Three facts an implementer must handle. `SqliteClient.layer` has error type `never` (`SqliteClient.ts:285-293`); `PgClient.layer` has `SqlError` because it connects eagerly (`PgClient.ts:347-349`); `MysqlClient.layer` has `Config.ConfigError | SqlError` (`MysqlClient.ts:445-447`), the `ConfigError` being a residue of its layer construction rather than anything a concrete config can raise. So `clientLayer`'s error channel is `SqlError | Config.ConfigError`, the SQLite and Postgres branches widen into it, and the mysql branch determines the type. Second, `PgClientConfig.url` and `password` are `Redacted.Redacted` (`PgClient.ts:81`, `:89`), as is `MysqlClientConfig.url` (`MysqlClient.ts:186`), so the credential is redacted from logs and traces by construction. Keep it in `Redacted` end to end; never `Redacted.value` it outside the layer factory, the child environment map and the dump subprocess environment. Third, redaction is not only a logging concern, because boot deliberately shows child stderr to agents. `packages/boot/src/supervisor.ts:78` and `packages/boot/src/cutover.ts:263`, `:273` redact with `text.replace(/[a-f0-9]{64}/g, "[redacted]")`, which is shaped for the boot secret and the writer epoch and does nothing to a connection string. A child that dies on a bad `DATABASE_URL` prints it, and `SPEC.md` §7.1 invariant 5 requires the stderr tail in the failure body and `generations.stderr` stores it. `redactUrls` is applied at both sites before anything is stored or returned, the child wraps a failed `Store.clientLayer` into a typed error carrying host and database name only, and section 12.3 item 8 is the test that a wrong-password start produces a failure body with no password in it.

`intCodecRegistry` is explained in section 7.5: without it, every Postgres `bigint` column decodes to a JavaScript `bigint` and every `Schema.Int` decoder in the codebase fails.

### 4.3 The server's mirror

The parser, the descriptor type, the derivations and the client-layer factory live in their own workspace, `packages/storage`, which boot and the server both depend on. They cannot live in `packages/boot` and be re-exported: `packages/server/stage-runtime.ts` builds the frozen editable runtime from `packages/server/runtime/package.json`, which lists `protocol` and `storage` and deliberately not `@comms/boot`, and it deletes `start.ts`, the one file under `packages/server/src` that imports boot, from the seed. A boot re-export would resolve in the repository and fail in every editable generation. They cannot live in `packages/protocol` either, because `scripts/check-invariants.ts` permits `ui → protocol` and the UI is bundled for a browser, while the client factory must pull `@effect/sql-sqlite-bun` now and `@effect/sql-pg` and `@effect/sql-mysql2` at steps 5 and 6. `check-invariants.ts` enforces that only `boot` and `server` may import `@comms/storage`, and the package imports neither boot nor application code. (Corrected 2026-09-11 from PR #2; an earlier revision had the server re-export boot's module, which cannot resolve in an editable generation.) The server reads the descriptor at `packages/server/src/kernel/boot-channel.ts:74`, which becomes:

```ts
const store = yield* Config.Redacted("APP_STORE").pipe(
  Effect.flatMap((raw) => Store.parse(Redacted.value(raw))),
);
```

`Config.Redacted` rather than `Config.String` so the credential never lands in a log line, the same treatment `BOOT_SECRET` already gets at `boot-channel.ts:115`.

### 4.4 What replaces `APP_DATABASE`

| Today | Becomes |
| --- | --- |
| `APP_DATABASE: filename` in the child env map, `packages/boot/src/supervisor.ts:117` | `APP_STORE: Redacted.value(Store.render(appStore))`, where `appStore` carries the app credential and the journaled database name |
| `const filename = yield* Config.String("APP_DATABASE")`, `packages/server/src/kernel/boot-channel.ts:74` | `Store.parse` of `Config.Redacted("APP_STORE")` |
| `SqliteClient.layer({ filename: boot.filename, disableWAL: true })`, `packages/server/src/server.ts:241` | `Store.clientLayer(boot.store)` |
| `SqliteClient.layer({ filename: boot.filename, readonly: true, disableWAL: true, busyTimeout: "100 millis" })`, `packages/server/src/kernel/sql-read.ts:71` | `DbOps.readOnlySession` (section 11) |
| `SqliteClient.layer({ filename, disableWAL: true })` inside boot, `packages/boot/src/app-recovery.ts:104` and `packages/boot/src/app-backup.ts:26`, `:33` | `Store.clientLayer(bootViewOfAppStore)`, the derived descriptor from section 3.2, never the app's |

**`APP_DATABASE` is not simply renamed.** Retained generations are immutable source snapshots, and one taken before this change reads `APP_DATABASE`; dropping it would make every pre-descriptor rollback target unlaunchable, which is the path `SPEC.md` §7.1 relies on. Boot emits both variables, and the child and the keeper both refuse a pair that names two different files (`store_descriptor_mismatch`). The alias is removable once no retained generation can predate the descriptor, five good generations plus the live one, which requires a per-generation contract stamp so boot can refuse an unstamped snapshot instead of launching it wrongly. (From PR #2, 2026-09-11.)

`AppRecovery.filename` at `packages/boot/src/app-recovery.ts:25` becomes `AppRecovery.store`, a `Ref` rather than a constant, for the reason section 10.3 gives. That rename is the mechanical bulk of step 1 in section 13, and it is **not** behaviour-preserving on its own: the `fs.exists` checks at `app-recovery.ts:29` and `packages/boot/src/cutover.ts:143` have no remote form, and section 10.3 specifies what replaces them.

### 4.5 Rehearsal and drills through the existing seam

The descriptor slots into the parameter that already varies. `packages/boot/src/supervisor.ts:86-92` is:

```ts
const launch = (
  generation: Generation,
  filename: string,
  mode: "candidate" | "rehearsal",
  rehearsalSequence?: number,
  epochOverride?: string,
) => …
```

`filename: string` becomes `store: StoreDescriptor`. Three callers already pass something other than the live store through it: `packages/boot/src/cutover.ts:150-152` passes the rehearsal clone, `packages/boot/src/database-restore.ts:129` passes the live store with an epoch override, and the drill (now app-side, section 10.4) passes a drill clone. The descriptor a child receives always carries the app credential: for a clone it is `withDatabase(appStore, cloneName)`. Nothing else about the seam changes, and rehearsal keeps having no boot secret and no access to the public allocator by construction at `packages/server/src/kernel/boot-channel.ts:77-113`.

---

## 5. `DbOps`

### 5.1 The interface

`packages/boot/src/db-ops.ts`. One service, one implementation per engine, and it absorbs `packages/boot/src/app-backup.ts` wholesale.

```ts
import { Context, Effect, Option, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { StoreDescriptor } from "./store.ts";

export class DbOpsError extends Schema.TaggedError<DbOpsError>()("DbOpsError", {
  code: Schema.Literals([
    "clone_failed",          // the copy could not be made at all
    "clone_load_failed",     // the dump was produced but the target rejected its contents on load
    "rehearsal_copy_timeout",
    "scratch_limit",         // too many scratch databases already exist; nothing was created
    "backup_failed",
    "backup_engine_mismatch",
    "restore_failed",
    "drop_failed",
    "tool_missing",
  ]),
  detail: Schema.optionalKey(Schema.String),
}) {}

/** A disposable copy. Lifetime is explicit, never a Scope finalizer: see 5.4. */
export interface Clone {
  readonly store: StoreDescriptor;   // app-credentialed, for the child
  readonly label: string;
}

/** A restorable artefact. `path` is a file on the volume on every engine; `engine` is the dialect that wrote it. */
export interface Artefact {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly engine: "sqlite" | "pg" | "mysql";
}

export interface Capacity {
  readonly used: Option.Option<number>;
  readonly total: Option.Option<number>;
}

export interface DbOpsService {
  readonly dialect: "sqlite" | "pg" | "mysql";
  /** Boot's view of the live app store (section 3.2). */
  readonly store: Effect.Effect<StoreDescriptor>;

  readonly cloneForRehearsal: (label: string) => Effect.Effect<Clone, DbOpsError | SqlError.SqlError>;
  readonly backup: (id: string) => Effect.Effect<Artefact, DbOpsError | SqlError.SqlError>;
  /** Restores into a fresh target and returns the app-credentialed descriptor of the store now live. */
  readonly restoreInto: (artefact: Artefact) => Effect.Effect<StoreDescriptor, DbOpsError | SqlError.SqlError>;
  readonly dropClone: (clone: Clone) => Effect.Effect<void, DbOpsError>;
  readonly reapClones: Effect.Effect<ReadonlyArray<string>, DbOpsError>;
  readonly capacity: Effect.Effect<Capacity>;

  readonly readOnlySession: <A, E, R>(
    effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  readonly tableExists: (name: string) => Effect.Effect<boolean, SqlError.SqlError, SqlClient.SqlClient>;
}

export class DbOps extends Context.Service<DbOps, DbOpsService>()("comms/boot/DbOps") {}
```

`Context.Service<Self, Shape>()("tag")` is the two-parameter form the repo already uses at `packages/boot/src/app-backup.ts:49-51` and `packages/server/src/kernel/boot-channel.ts`, and the form Effect's own MySQL test utilities use at `repos/effect/packages/sql/mysql2/test/utils.ts:21-24` (the pg utilities at `pg/test/utils.ts:9` use the one-parameter `{ make }` form).

`readTransaction` is deliberately **not** on `DbOps`: it is a statement-shaped concern used by seven server read paths, so it lives in `dialect.ts` (section 6.9) where the server can reach it without depending on a boot service.

### 5.2 What each method does, per engine

| Method | SQLite | Postgres | MySQL |
| --- | --- | --- | --- |
| `cloneForRehearsal` | `PRAGMA busy_timeout = 2000` then `VACUUM INTO ?` on a fresh non-WAL connection, then fsync the file and its parent directory. This is `app-backup.ts:17-27` unchanged. | Refuse with `scratch_limit` if more than `SCRATCH_DATABASE_LIMIT` (default 4) scratch databases exist. `CREATE DATABASE comms_rehearsal_<label> OWNER comms_app`, the three access statements from section 3.2, then `pg_dump -Fc` of the live database piped into `pg_restore -d comms_rehearsal_<label>`, both as `comms_boot`. A `pg_restore` that exits non-zero after the database was created is `clone_load_failed`, not `clone_failed`. Returns `withDatabase(appStore, name)`. | Same limit. `CREATE DATABASE comms_rehearsal_<label> CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs`, then `mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF --triggers` piped into `mysql`. Same two failure codes. Returns a `mysql://` descriptor. |
| `backup` | The same `VACUUM INTO` into `backups/<id>.db`, fsynced, size recorded. | `pg_dump -Fc` (owners and privileges kept, so a restore can re-issue `OWNER TO comms_app`; **not** `--no-owner --no-privileges`) to `backups/<id>.dump`, fsynced, size recorded, `engine: "pg"`. | `mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF --triggers` to `backups/<id>.sql`, fsynced, size recorded, `engine: "mysql"`. The clone and the backup use the same flags so a rehearsal sees what a restore would produce. `--no-tablespaces` is not optional: since MySQL 8.0.21 `mysqldump` reads `INFORMATION_SCHEMA.FILES` to emit tablespace statements, which needs the global `PROCESS` privilege, and `PROCESS` is grantable only `ON *.*`, so without the flag every backup, clone and drill fails with an access-denied error from the subprocess on a correctly provisioned server. comms has no tablespace to preserve. `--routines` and `--events` are not passed: comms defines no stored routines or events, `SHOW CREATE PROCEDURE` needs `SHOW_ROUTINE` or global `SELECT` for routines the dumping user did not define, and an agent-defined routine is therefore outside what a backup captures (section 14.4 item 8). |
| `restoreInto` | The close-handle protocol at `app-backup.ts:35-46`: copy to `${filename}.restore`, fsync, remove `-wal` and `-shm`, rename, fsync the parent. Returns the same descriptor. Refuses an artefact whose `engine` is not `sqlite` with `backup_engine_mismatch`. | Refuses a foreign artefact the same way. `CREATE DATABASE comms_app_<n> OWNER comms_app`, the access statements, `pg_restore` into it as `comms_boot`, then **journal the new name in the boot store** (section 10.3) and return `withDatabase(appStore, "comms_app_<n>")`. Nothing is ever mutated under a live reader. | Same shape with `mysql < dump`. |
| `dropClone` | `fs.remove(path, { force: true })`. | `REVOKE CONNECT ON DATABASE <clone> FROM PUBLIC, comms_app`, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '<clone>'` (legal through membership), then `DROP DATABASE <clone> WITH (FORCE)` (Postgres 13+). `DbOps` never holds a connection to the clone it is dropping: the drop runs on the boot-store connection. A failed drop is `drop_failed`, is not fatal to the caller, and is what `reapClones` picks up. | `DROP DATABASE <clone>`. |
| `reapClones` | Remove stale `*.rehearsal.db` files under the generation directory whose generation is retired. | `SELECT datname FROM pg_database WHERE datname LIKE 'comms\_rehearsal\_%' ESCAPE '\' OR datname LIKE 'comms\_drill\_%' ESCAPE '\'`, drop those not referenced by a live record. **Never** `comms_app_%`: restore targets are the live store and its predecessors, and only a human drops those (section 10.5). | Same over `information_schema.SCHEMATA`, same escaping. |
| `capacity` | `{ used: Some(file size), total: Some(volume capacity) }` from the existing probe (`readStorageVolume`, `packages/boot/src/storage-volume.ts:48-84`). | `{ used: Some(pg_database_size(current_database())), total: None }`. | `{ used: Some(SUM(data_length + index_length) FROM information_schema.TABLES WHERE table_schema = DATABASE()), total: None }`. |
| `readOnlySession` | A second connection with `readonly: true`, which sets `beginTransaction: "BEGIN"` rather than `"BEGIN IMMEDIATE"` (`SqliteClient.ts:238`) and opens the file read-only (`:132-136`). | `sql.reserve` (`SqlClient.ts:52`) to hold one connection, then on that connection `START TRANSACTION READ ONLY`, the statement, and `COMMIT` (or `ROLLBACK` in the finalizer). | Identical: `START TRANSACTION READ ONLY` is valid MySQL and takes effect for that transaction. `SET TRANSACTION READ ONLY` is **not** used, because without `SESSION` or `GLOBAL` it applies to the *next* transaction and raises `ER_CANT_CHANGE_TX_CHARACTERISTICS` (1568) once one is open, and `sql.withTransaction` fixes its opening statement per client (`SqlClient.ts:171`) with no per-call option (`:57-59`). |
| `tableExists` | `SELECT name FROM sqlite_master WHERE type='table' AND name=?` | `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname=current_schema() AND c.relname=?::text`. Not `to_regclass`, which resolves views, indexes and sequences too and follows `search_path` into other schemas. | `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?` |

`capacity` on SQLite is **not** a `statvfs` call. `readStorageVolume` (`packages/boot/src/storage-volume.ts:48-84`) spawns `/usr/bin/stat -f -c '%S %b %a'` on Linux and `/bin/df -kP` on darwin (`:61-62`) under `LC_ALL=C` and a two-second timeout, and `parseStorageVolume` (`:18-45`) accepts only fixed numeric output. `DbOps.capacity` delegates to it rather than introducing a second mechanism.

`readOnlySession` runs the caller's effect against the reserved connection, not against the pooled client, so the whole route executes inside the one read-only transaction; the `SqlClient` it provides is a thin client over that connection. On Postgres a read-only transaction rejects every write with `25006`; on MySQL with `1792`. Both are what the route wants.

### 5.3 The rehearsal deadline and `rehearsal_copy_timeout`

Today the rehearsal copy has no budget at all. `packages/boot/src/cutover.ts:144-147` clone and prepare before the launch at `:150-152`, and the `Effect.timeout("30 seconds")` at `:154` is piped onto `rehearsed.process.health`, so it bounds only the child's self-test. On SQLite that is survivable because `VACUUM INTO` is a local file copy; on a remote engine a dump and load can hang indefinitely inside an edit. The hourly path is inconsistent in the other direction: `packages/boot/src/scheduled-backup.ts:96` wraps its whole capture, including the `backup.clone` at `:66`, in a ten-second budget. Give the copy its own budget in both places:

- `DbOps.cloneForRehearsal` and `DbOps.backup` get their own budget, `REHEARSAL_COPY_BUDGET`, default 30 seconds on SQLite and 120 seconds on a remote engine. Exceeding it fails with `DbOpsError { code: "rehearsal_copy_timeout" }`, which the edit route surfaces verbatim.
- The child's self-test keeps the existing 30-second deadline from `SPEC.md` §7.1.

The distinction matters because `rehearsal_copy_timeout` means "your store is too large for the configured rehearsal budget", which the agent cannot fix by editing, while a self-test failure means "your edit is broken", which it can. Reporting the first as the second sends an agent to debug code that is fine. `clone_load_failed` is kept distinct for the same reason: a dump the target refuses to load is neither a size problem nor an edit problem, and the message must not point at either.

### 5.4 Clone lifetime is explicit, never a `Scope` finalizer

It is tempting to make `cloneForRehearsal` scoped so the clone drops automatically. Do not. The drill deliberately leaves the scratch behind when closure is unproven, so the bytes remain for diagnosis; that was the purpose of the `removable` flag in the deleted `backup-drill.ts`. A `Scope` finalizer would drop the scratch on every exit path, including the one where an orphaned child may still be connected to it.

"Only after closure is proven" is a precondition, not a deferral. On SQLite the rehearsal copy lives inside the materialized proposal tree (`cutover.ts:144`) and disappears with it, which is what `SPEC.md` §7.5 promises. On a remote engine nothing in the cutover sequence would drop the clone, and a box that boots once a month and takes thirty edits a day would accumulate nine hundred copies of the board on the production server. So the cutover calls `dropClone` on the **success path too**: `cutover.ts:168` already retires the rehearsal child under `Effect.ensuring`, and `supervisor.retire` produces the closure receipt, so the drop goes immediately after it, before the freeze. `reapClones` (section 10.5) is the backstop for what a crash between the receipt and the drop leaves behind, and the `scratch_limit` refusal in section 5.2 is the guard against the reaper never running.

### 5.5 Binaries the image gains

`repos/effect/packages/sql/pg/src/PgMigrator.ts:48-64` shows the shape Effect uses to shell out to `pg_dump`: `ChildProcess.make("pg_dump", args, { env })` piped through `ChildProcessSpawner.ChildProcessSpawner`'s `spawner.string`, with `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE` in the child environment. comms uses the same shape but **not** the same source for those values. `PgMigrator` reads them from `sql.config` (`PgMigrator.ts:55-62`), which is the options object verbatim (`PgClient.ts:152`); comms configures the client with `url` alone (section 4.2), so every one of those fields would be `undefined` there, and the URL is parsed privately inside `PgConnection` (`PgConnection.ts:2136-2160`). An implementer copying `PgMigrator`'s shape would get a `pg_dump` with an empty environment that falls back to ambient `PGHOST`/`PGUSER` or local socket defaults. `DbOps` builds the environment from the `StoreDescriptor` it holds, which is the one place the credential is parsed. This means:

- **Postgres: `postgresql-client`** in the image, for `pg_dump`, `pg_restore` and `psql`. `docs/tech.md` §10 currently lists only `util-linux`.
- **MySQL: `mysql-client`**, for `mysqldump` and `mysql`. `repos/effect/packages/sql/mysql2/src/MysqlMigrator.ts:35-87` has its dump path commented out pending a `Command` module, and the commented code targets the Effect v3 `Command` API, so comms writes the MySQL dump path itself against `ChildProcess`.
- **SQLite: nothing.** `repos/effect/packages/sql/sqlite-bun/src/SqliteMigrator.ts:35` onward likewise has its `sqlite3`-based dump commented out, and comms does not need it: `VACUUM INTO` is a statement, not a binary.

Credentials go to the subprocess in its environment map, never on the command line, because a command line is visible in `ps`. On MySQL this is not optional in the way it is on Postgres: `mysqldump -p<password>` is the documented form and it leaks the credential to every process on the box, so comms passes `MYSQL_PWD` in the environment and never builds a `-p` argument. Both binaries are required in the image; neither engine is optional, so neither client package is a conditional layer in the Dockerfile. The credential in that environment is always `comms_boot`'s (section 3.2).

---

## 6. `dialect.ts`

`packages/boot/src/dialect.ts`, re-exported by the server. Roughly 250 lines. It contains no table name, so the CI grep from R12 stays clean: every helper takes identifiers as parameters.

### 6.1 The three-dialect wrapper

`sql.onDialect` requires all five branches (`repos/effect/packages/effect/src/unstable/sql/Statement.ts:518-524`); `sql.onDialectOrElse` takes an `orElse` plus any subset (`:526-533`). comms supports three, so one wrapper makes the intent explicit and fails loudly on the other two.

```ts
import type { SqlClient } from "effect/unstable/sql";
import type { Fragment } from "effect/unstable/sql/Statement";

export const on = <A>(
  sql: SqlClient.SqlClient,
  branches: { readonly sqlite: () => A; readonly pg: () => A; readonly mysql: () => A },
): A =>
  sql.onDialectOrElse({
    orElse: () => { throw new Error("comms supports sqlite, pg and mysql only"); },
    sqlite: branches.sqlite,
    pg: branches.pg,
    mysql: branches.mysql,
  });
```

`onDialectOrElse` is synchronous and returns the branch's value (`Statement.ts:608-610`), so it composes inside a `sql` template as a `Fragment` without any effect wrapping.

### 6.2 `isDescendant(sql, child, ancestor)` — 41 sites

| Engine | Emits |
| --- | --- |
| sqlite | `substr(${child},1,length(${ancestor})+1)=${ancestor}\|\|'/'` |
| pg | `starts_with(${child}, ${ancestor} \|\| '/')` |
| mysql | `substr(${child},1,char_length(${ancestor})+1)=CONCAT(${ancestor},'/')` |

`||` is string concatenation in SQLite and Postgres and logical OR in MySQL unless `PIPES_AS_CONCAT` is set, which is why MySQL needs `CONCAT`. Postgres additionally gains an index-friendly form: `starts_with` is immutable and has btree planner support from Postgres 15 with a `text_pattern_ops` index, where the `substr` form cannot use one. Both arguments are frequently bound parameters (`substr(${input.topic},1,length(path)+1)=path||'/'` at `packages/server/src/kernel/messages.ts:100` binds the *child*), so on Postgres the helper casts bound values with `::text` per section 6.7a.

At the working tree there are 46 `substr(` occurrences (`grep -ro 'substr(' packages/boot/src packages/server/src | wc -l`; the investigation counted 33 and the reviews 49, because the base work is rewriting these files). **41** have this prefix-match shape and are served by the helper. The other five are three different constructs and none of them is served by it: four suffix rewrites during a topic move (`packages/boot/src/events.ts:145`, `packages/boot/src/public-paths.ts:60`, `packages/server/src/kernel/topic-move.ts:122` and `:126`), which concatenate with `||` in a value position and are section 6.2a; and one literal-prefix test at `packages/server/src/kernel/idempotency.ts:254` (`substr(transaction_id,1,4)='ext:'`), which is portable as written, as is the bound-length prefix at `packages/server/src/kernel/operational-events.ts:47`. Representative prefix sites: `messages.ts:100`, `published-messages.ts:15`, `topics.ts:53-58`, `public-paths.ts:54`.

### 6.2a `replacePrefix(sql, column, from, to)` — 4 sites

| Engine | Emits |
| --- | --- |
| sqlite | `${to}\|\|substr(${column},length(${from})+1)` |
| pg | `${to}::text \|\| substr(${column},length(${from}::text)+1)` |
| mysql | `CONCAT(${to},substr(${column},char_length(${from})+1))` |

The topic-move rewrite of `events.topic` (`events.ts:145`), `public_paths.path` (`public-paths.ts:60`), `messages.topic` (`topic-move.ts:122`) and `reads.topic` (`:126`). The value-position `||` is a logical OR on MySQL, so the rewrite would silently set every moved path to `0` or `1` rather than fail. It gets the same generated-SQL test per dialect as the helpers in section 6.6 and 6.7.

### 6.3 `jsonText(sql, column, key)` and `jsonInt(sql, column, key)` — 19 occurrences

The helper takes a single top-level key, not a JSON path, because every current use is one level deep (`$.body`, `$.tags`, `$.meta`, `$.edited_at`, `$.deleted_at`, `$.at`, `$.type`). Nested paths need `#>>'{a,b}'` on Postgres and are out of scope until something needs one.

| Engine | `jsonText` | `jsonInt` |
| --- | --- | --- |
| sqlite | `json_extract(${col},'$.${key}')` | same |
| pg | `${col} ->> '${key}'` (column is `jsonb`) | `(${col} ->> '${key}')::bigint` |
| mysql | `${col} ->> '$.${key}'` | `CAST(NULLIF(${col} ->> '$.${key}','null') AS SIGNED)` |

The `NULLIF` on MySQL is not cosmetic. `JSON_UNQUOTE(JSON_EXTRACT(x,'$.k'))` on a JSON `null` returns the four-character string `null`, not SQL `NULL`, and `CAST('null' AS SIGNED)` is `0`. Postgres `->>` and SQLite `json_extract` both return SQL `NULL`. Without the `NULLIF`, `edited_at` on MySQL decodes as `0` rather than `null` and every `deleted_at IS NULL` filter silently stops working.

### 6.4 `jsonArrayHas(sql, column, value)` — 1 site, and one that is not this helper

| Engine | Emits |
| --- | --- |
| sqlite | `EXISTS(SELECT 1 FROM json_each(${col}) WHERE value=${value})` |
| pg | `EXISTS(SELECT 1 FROM jsonb_array_elements_text(${col}) e WHERE e=${value}::text)` |
| mysql | `JSON_CONTAINS(${col}, JSON_QUOTE(${value}), '$')` |

Postgres has a shorter form, `${col} ? ${value}`, and it is the wrong choice here: the `?` operator collides visually with the placeholder style of the other two engines and confuses anyone reading a mixed codebase. `jsonb_array_elements_text` costs nothing at this scale.

The one site is the tag filter at `packages/server/src/kernel/messages.ts:230`. The other `json_each` use, the mention filter at `messages.ts:201`, is deliberately **not** routed through this helper: it iterates `json_each(CASE WHEN … THEN mention_source.previous_mentions ELSE mention_source.mentions END)` in a `FROM` clause and intersects it with `json_each(${JSON.stringify(targets)})`, a bound JSON string. It gets its own three-dialect fragment (`jsonb_array_elements_text(CASE … END)` and `jsonb_array_elements_text(${targets}::jsonb)` on Postgres, `JSON_TABLE` on MySQL) and its own generated-SQL test. Both bound JSON strings need the `::jsonb` cast on Postgres for the reason in section 6.7a.

### 6.5 `upsert(sql, table, row, conflict, set)` — 8 sites

| Engine | Emits |
| --- | --- |
| sqlite | `INSERT INTO t ${sql.insert(row)} ON CONFLICT(${conflict}) DO UPDATE SET x=excluded.x` |
| pg | identical |
| mysql | `INSERT INTO t ${sql.insert(row)} AS new ON DUPLICATE KEY UPDATE x=new.x` |

`sql.insert` accepts a record or an array of records and is at `Statement.ts:465-470`. The MySQL row alias form (`AS new`) requires 8.0.19 or later; the older `VALUES(col)` form is deprecated and should not be emitted. There are 8 `ON CONFLICT` sites at the working tree.

A `set` of `[]` means `ON CONFLICT (…) DO NOTHING` on SQLite and Postgres and `ON DUPLICATE KEY UPDATE <first conflict column>=<first conflict column>` on MySQL — **not** `INSERT IGNORE`, which downgrades every error the statement can raise to a warning, including truncation, range and `NOT NULL` failures, and would turn a real constraint violation on a token-binding statement into a silently skipped row. It covers the five `INSERT OR IGNORE` sites (`packages/boot/src/application.ts:108`, `:117`, `packages/boot/src/app-recovery.ts:42`, `:109`, `packages/boot/src/generations.ts:32`) and the three `DO NOTHING` sites (`packages/boot/src/public-paths.ts:48`, `packages/boot/src/tokens.ts:137`, `packages/server/src/kernel/topic-move.ts:120`).

One behaviour note. `INSERT OR REPLACE` deletes the existing row and inserts a new one, so it resets unmentioned columns to their defaults. The single remaining site, `packages/boot/src/edit-lock.ts:233`, supplies every column of the `edit_lock` singleton (schema at `boot-schema.ts:53-59`), so the rewrite to an upsert is behaviour-preserving. Any future `INSERT OR REPLACE` would need that checked before conversion. The edit-lock acquire is also a read-modify-write on a singleton, so R14 applies to it (section 9.3).

### 6.6 `greatest(sql, a, b)` — 1 site

`MAX(a,b)` on SQLite, `GREATEST(a,b)` on Postgres and MySQL. The site is `packages/server/src/kernel/topic-move.ts:126`. It fails loudly on both remote engines (section 1.3), in a path that only runs during a topic move and so will not be hit by ordinary smoke testing, which is the reason to fix it now rather than the reason it is dangerous. The generated-SQL test per dialect stays, because the helper is cheap and the site is easy to forget.

### 6.7 `distinctFrom(sql, a, b)` — 1 site

`a IS NOT b` on SQLite, `a IS DISTINCT FROM b` on Postgres, `NOT (a <=> b)` on MySQL. The site is `packages/boot/src/events.ts:245`, the null-safe instance exclusion in the `/_boot/events` filter. Getting it wrong does not error: it silently drops events from a long-poll, which is the worst failure shape in the whole list. Write a test that asserts the generated SQL text per dialect.

### 6.7a `nullable(sql, value)` — 7 bound-null tests in 4 statements

The optional-filter idiom `(${x ?? null} IS NULL OR col=${x ?? null})` appears at `packages/server/src/kernel/messages.ts:228-230` (three times), `packages/boot/src/account-queries.ts:48` and `:61`, and `packages/boot/src/backup-inventory.ts:20` (`grep -rno '} IS NULL' packages/boot/src packages/server/src`; the reviews counted thirteen before the base work rewrote `events.ts`). It works on SQLite and MySQL and fails to parse on Postgres. The pg adapter binds `null` with type OID `0`, meaning "let the backend infer" (`repos/effect/packages/sql/pg/src/PgConnection.ts:790`), and binds strings the same way on purpose (`:806-810`); `$1 IS NULL` gives the backend nothing to infer from, so Postgres answers `42P18 could not determine data type of parameter $1` at parse time.

| Engine | Emits |
| --- | --- |
| sqlite | `${value}` |
| pg | `${value}::text` (or the column's type) |
| mysql | `${value}` |

Every bound value that appears in a type-free position — `IS NULL`, `IS DISTINCT FROM`, the bare side of a `CASE`, an argument to a polymorphic function, a bound JSON document handed to `jsonb_array_elements_text` — needs the cast on Postgres. This is the second silent-on-SQLite, loud-on-Postgres class after the `int8` codec in section 7.5, and unlike that one it fails at parse time, so the pglite suite catches every site at once.

### 6.7b `globPrefix(sql, column, prefix)` and planner hints — 3 sites plus 2

The base work rewrote the `/_boot/events` filter with three SQLite `GLOB` matches (`packages/boot/src/events.ts:242`, `:245`, `:254`) and two planner hints (`NOT INDEXED` at `:272`, `INDEXED BY` at `:273`). `GLOB` exists only in SQLite. The two subtree matches (`topic GLOB 'x/*'`) are `isDescendant`; the two type matches (`type GLOB 'message.*'`, `type GLOB '<escaped prefix>*'`) are a literal-prefix test, for which the helper emits `substr(${column},1,${prefix.length})=${prefix}` on SQLite and MySQL and `starts_with(${column}, ${prefix}::text)` on Postgres, with no escaping needed because nothing is a pattern any more. The planner hints have no equivalent and must not be emitted off SQLite: the helper returns an empty fragment on pg and mysql and the events index set in section 7.2 is what makes those planners choose correctly. These are three sites the reviews could not have caught, because they landed after both reviews were written, and they are the concrete reason habit 1 in section 1.3 exists.

### 6.8 `returning(sql, statement, columns)` — 5 sites

`repos/effect/packages/effect/src/unstable/sql/Statement.ts:994-1005` shows the compiler emits `RETURNING <cols>` for every dialect except mssql, which gets `OUTPUT` (there is a second, unconditional `RETURNING` emission for the insert helper at `:938-946`). So SQLite and Postgres take the five statements verbatim. MySQL supports none of them and needs a select in the same transaction.

**Never branch on MySQL's affected-row count.** MySQL's default affected-rows semantics count rows *changed*, not rows *matched*: an `UPDATE` that sets a column to the value it already holds reports `affectedRows = 0` unless the connection was opened with `CLIENT_FOUND_ROWS`, and `MysqlClientConfig` (`repos/effect/packages/sql/mysql2/src/MysqlClient.ts:182-209`) exposes that flag only through `poolConfig`, which the URL form of the client ignores (`MysqlClient.ts:310-318`). Three of the five statements are no-op-shaped at least sometimes: the fence is a deliberate `SET epoch=epoch`, `recovery.prepare(epoch, epoch)` at `packages/boot/src/database-restore.ts:137` re-installs the epoch already there, and `last_seen_at` can equal the previous millisecond. A healthy writer would declare itself `stale_writer` on every mutation. The MySQL form is therefore a locking select or a select after the write, and the row count comes from the select.

| Site | Statement | MySQL replacement |
| --- | --- | --- |
| `packages/server/src/kernel/database.ts:9` | `UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=? RETURNING epoch` | `SELECT epoch FROM kernel_writer WHERE singleton=1 AND epoch=? FOR UPDATE`; zero rows is `stale_writer`. The locking read takes the same exclusive row lock, waits for a concurrent holder, and re-evaluates the predicate against the committed row after the wait. |
| `packages/boot/src/app-recovery.ts:44` | `UPDATE kernel_writer SET epoch=? WHERE singleton=1 RETURNING epoch` | `SELECT epoch FROM kernel_writer WHERE singleton=1 FOR UPDATE` (exactly one row, else `app_fence_invalid`), then `UPDATE kernel_writer SET epoch=? WHERE singleton=1` |
| `packages/boot/src/generations.ts:35-36` | `INSERT INTO generations (…) VALUES (…) RETURNING *` | `INSERT`, then `SELECT * FROM generations WHERE n=LAST_INSERT_ID()` |
| `packages/boot/src/auth.ts:338` | `UPDATE sessions SET last_seen_at=? WHERE hash=? AND expires_at>? RETURNING id, expires_at` | `UPDATE`, then `SELECT id,expires_at FROM sessions WHERE hash=? AND expires_at>?` with the same predicate, under the row lock the update took |
| `packages/boot/src/event-retention.ts:36-38` | `DELETE FROM events WHERE … RETURNING seq` | `SELECT seq FROM events WHERE seq>? AND seq<=? AND <the age predicate> ORDER BY seq LIMIT 256`, then `DELETE … WHERE seq IN (…)`; `deleted` counts the select's rows |

**The select-after-write rule.** Every one of these substitutions is atomic only because the write already took a row lock that the following select reads under. That holds for the `INSERT` and the two `UPDATE` cases inside `sql.withTransaction`. The `DELETE` case is different in two ways: it needs the select *before* the delete, and the age predicate must move into that select. The existing select at `event-retention.ts:31` is a range scan only (the comment at `:29` says why: "Bound rows scanned, not just rows deleted"), and the predicate lives in the `DELETE` at `:36-38`, so deleting by the range-only candidate list would remove young rows. Do not write this helper as a generic "run the statement then select the same predicate"; it would be wrong for the delete.

### 6.9 `readTransaction(sql, effect)` — 7 sites

This is the subtlest thing in the design and it gets its own treatment in section 9.2. The helper signature:

```ts
export const readTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError.SqlError, R>;
```

It wraps `sql.withTransaction` and issues a per-dialect prelude as the first statement inside. It must skip the prelude when already nested, detected through `Effect.serviceOption(sql.transactionService)`: the service payload is `readonly [conn, depth]` (`SqlClient.ts:363`), so a present service means `withTransaction` will issue a `SAVEPOINT` rather than a `BEGIN` (`SqlClient.ts:288`, `:294`). Postgres raises `25001` for `SET TRANSACTION ISOLATION LEVEL` in two situations, and a nested read hits both: once any query has run in the transaction ("must be called before any query"), and inside a subtransaction, which a `SAVEPOINT` opens ("must not be called in a subtransaction"). The nesting check is required, not defensive.

### 6.10 `tableExists` and the per-column cast discipline

`tableExists` lives on `DbOps` rather than in `dialect.ts` because boot calls it outside a statement context; the SQL per engine is in section 5.2. Its only remaining caller is the adopt step in section 7.3: the `sqlite_master` probe in `public-pages.ts` that the investigation cited is gone, because that module now reads the boot-owned `public_paths` table (`packages/boot/src/public-pages.ts:40`) and no longer discriminates on `user_version`.

The cast discipline is what keeps the `Schema` decoders working, and it is the place a careless port breaks silently. `packages/server/src/kernel/published-messages.ts:6-15` builds five `CASE WHEN updated_seq>? THEN json_extract(previous,'$.x') ELSE x END` columns, and `packages/server/src/kernel/messages.ts:48-52` decodes the result with `tags` and `meta` as `Schema.fromJsonString(...)` and `edited_at`/`deleted_at` as `Schema.NullOr(Schema.Int)`. On SQLite `json_extract` returns a dynamically typed value that happens to match. On Postgres `->>` always returns `text`, and a `CASE` requires both branches to have the same type. So each column needs its own rule:

| Column | Decoder expects | Postgres form |
| --- | --- | --- |
| `body` | `Schema.String` | `CASE WHEN … THEN previous->>'body' ELSE body END` |
| `tags` | JSON text, parsed by `fromJsonString` | `CASE WHEN … THEN previous->>'tags' ELSE tags::text END` |
| `meta` | JSON text, parsed by `fromJsonString` | `CASE WHEN … THEN previous->>'meta' ELSE meta::text END` |
| `edited_at` | `NullOr(Int)` | `CASE WHEN … THEN (previous->>'edited_at')::bigint ELSE edited_at END` |
| `deleted_at` | `NullOr(Int)` | `CASE WHEN … THEN (previous->>'deleted_at')::bigint ELSE deleted_at END` |

`previous->>'tags'` on a `jsonb` member that is itself an array returns that array's JSON text, which is exactly what `fromJsonString` wants. `tags::text` on the other branch produces JSON text too, so the branches agree, which is also why `messages.tags` (and `mentions`, `previous_mentions`) must be `jsonb` on Postgres (section 7.2). This is the change the investigation called the most invasive group, and it is: it alters the shape of the published-image views that every read path composes.

---

## 7. Schema and migrations

### 7.1 Both ladders become `Migrator` modules

Two hand-written `PRAGMA user_version` ladders exist:

| Ladder | Range | Site |
| --- | --- | --- |
| Boot | v0 to v14 | `packages/boot/src/boot-schema.ts:38-90`, stamped at `:88` |
| App | v0 to v7 | `packages/server/src/kernel/database.ts:23-90`, stamped at `:43`, `:52`, `:65`, `:70`, `:74`, `:79` |

Both become `Migrator` migration modules. `packages/server/src/kernel/migrations.ts:48` already uses `Migrator.make({})({ loader, table: "migrations" })` for agent-authored migrations, so the app-side ladder joins an existing ledger rather than creating one; the boot side gets `table: "boot_migrations"`.

Three properties of the vendored `Migrator` matter:

- It creates its ledger with per-dialect DDL at `repos/effect/packages/effect/src/unstable/sql/Migrator.ts:120-151`, takes `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` on Postgres **only** at `:224-227` (`orElse: () => Effect.void`), and classifies a concurrent run as `Locked` through `UniqueViolation`/`ConstraintError` on the ledger insert at `:263-273`, `:326-327`. So concurrent migration on Postgres is handled for free; on MySQL the only defence is the unique violation on the batch insert, and section 14.4 item 1 says what that is worth once DDL has implicitly committed it.
- It wraps its `run` in its own `sql.withTransaction` at `:308`, and `packages/server/src/kernel/migrations.ts:45-49` already wraps that in an outer transaction. The inner therefore becomes a savepoint (`SqlClient.ts:294`), which is what keeps the epoch gate at `migrations.ts:47` atomic with the migrations it guards on SQLite and Postgres. That nesting is intentional and it should stay.
- **One Postgres hazard comes with that nesting, and it fires on the very first run.** `ensureMigrationsTable` runs at `Migrator.ts:305`, *outside* the migrator's own transaction but inside comms', and its pg branch probes `select ${table}::regclass` and creates the table in an `Effect.catch` (`Migrator.ts:135-144`). On a store that does not yet have the ledger that probe raises `42P01`; inside an open Postgres transaction any error aborts the whole transaction, so the `CREATE TABLE` in the handler fails with `25P02 current transaction is aborted`, and so does everything after it including the epoch gate's own commit. Effect's pg client issues no implicit per-statement savepoint (`SqlClient.ts:294` fires only for a nested `withTransaction`). comms must therefore create both ledgers itself, **before** opening any outer transaction, with `CREATE TABLE IF NOT EXISTS` and the column list from `Migrator.ts:139-143` (`migration_id integer primary key, created_at timestamp with time zone not null default now(), name text not null` on Postgres; the mysql and sqlite branches at `:129-134` and `:145-150`), so that by the time the migrator runs its probe succeeds and never raises. The adopt step in section 7.3 already needs the ledger to exist first, so this is one mechanism, not two.

`Migrator.make` takes `{ dumpSchema }` (`Migrator.ts:100-107`) and returns a function taking `{ loader, schemaDirectory?, table? }` (`Migrator.ts:29-33`). comms passes `{}` for the first, because no adapter in the vendored tree implements `dumpSchema` except `PgMigrator`, and comms has no use for a schema dump on the box.

### 7.2 Per-dialect DDL through `on`

| Concept | SQLite | Postgres | MySQL |
| --- | --- | --- | --- |
| Autoincrement key (`generations.n`, `versions.id`) | `INTEGER PRIMARY KEY AUTOINCREMENT` | `integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` | `INT AUTO_INCREMENT PRIMARY KEY` |
| Text key (22 `TEXT PRIMARY KEY` columns, 13 composite PKs, 14 `UNIQUE`s at the working tree) | `TEXT PRIMARY KEY` | `text PRIMARY KEY` | `VARCHAR(256) PRIMARY KEY` |
| Blob (`staging.content`, `source_changes.before`/`desired`, `versions.content`/`previous_content`) | `BLOB` | `bytea` | `LONGBLOB` |
| JSON (`settings.value`, `events.event`, `messages.tags`, `messages.meta`, `messages.previous`, `messages.mentions`, `messages.previous_mentions`, `topics.meta`, `topics.previous`, `kv.value`, `kv.previous`) | `TEXT` | `jsonb` | `JSON` |
| Epoch milliseconds | `INTEGER` | `bigint` | `BIGINT` |
| Integer boolean | `INTEGER … CHECK(x IN (0,1))` | `smallint … CHECK(x IN (0,1))` | `TINYINT … CHECK(x IN (0,1))` |
| Partial unique index | `CREATE UNIQUE INDEX … WHERE state='publishing'` | identical | generated column plus unique index |
| Events index set | `events_actor_seq`, `events_instance_seq`, `events_level_seq`, `events_type_seq`, `events_topic_seq` (`events.ts:262-266`) plus the planner hints | the same five indexes, no hints | the same five, no hints |

`VARCHAR(256)` covers every identifier: `m_` plus 24 hex (`packages/server/src/kernel/messages.ts:75`), `f_` plus 43 base64url (`packages/boot/src/refresh-schema.ts:7`), 64-hex epochs and attempts (`packages/boot/src/supervisor.ts:97-98`), topic paths capped at 200 (`messages.ts:53-54`), idempotency keys capped at 200. MySQL's `utf8mb4` 3072-byte index limit accommodates the composite keys at that width, but only just: the widest is `reactions(message_id,instance,emoji)` (`packages/server/src/kernel/database.ts:58`) at exactly 3 × 1024 bytes. A fourth text column in a composite key, or a width past 256, fails at `CREATE TABLE` on MySQL and nowhere else. Prefer the narrowest `VARCHAR` each column actually needs over a uniform 256 if a future key gets wider.

**Integer booleans stay integers.** `generations.good` (`boot-schema.ts:44`), `edit_lock.cutover_in_flight` (`:57`), `versions.versioned`, `child_attempts.opened`/`closed`, and the retained `reactions.active` are all decoded as `Schema.Literals([0, 1])`, for example `packages/boot/src/generations.ts:9`. Mapping any of them to a native `boolean` breaks every one of those decoders at runtime with no compile error. This is a trap rather than a cost, and it belongs in `AGENTS.md`.

**The partial unique index** at `packages/boot/src/source-schema.ts:70` enforces "at most one batch publishes at a time" in the database rather than in code. Postgres takes it verbatim. MySQL has no partial index; the substitute is a stored generated column plus a unique index on it:

```sql
ALTER TABLE source_batches
  ADD COLUMN publishing_singleton TINYINT
  GENERATED ALWAYS AS (CASE WHEN state='publishing' THEN 1 ELSE NULL END) STORED;
CREATE UNIQUE INDEX source_single_publication ON source_batches(publishing_singleton);
```

That works because MySQL's unique indexes ignore NULLs. It is the second MySQL-only schema contortion after `VARCHAR` keys, and the third is section 8.3's two full-text indexes.

**Bare columns in `GROUP BY`.** The `agent-roster.ts` query the investigation flagged is deleted in the working tree. The remaining `GROUP BY` sites are already portable: `packages/boot/src/account-queries.ts:56-62` wraps every non-grouped column in `MIN()`/`MAX()`, and `packages/server/src/ext/standup.ts:16` selects only the grouped column and a `COUNT`. Postgres and MySQL (under the default `ONLY_FULL_GROUP_BY`) both reject a bare column that SQLite would silently pick an arbitrary row for, so the pglite suite catches any future one.

### 7.3 The adopt step

An existing `boot.db` at `user_version = 14` must not re-run migrations 1 through 14. On first boot under the new code, a one-time adopt step stamps the ledger and then never reads `user_version` again:

```ts
const adopt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureLedger;                                              // CREATE TABLE IF NOT EXISTS, outside any transaction (7.1)
  const applied = yield* highestApplied(sql);                       // SELECT migration_id … ORDER BY migration_id DESC LIMIT 1
  if (Option.isSome(applied)) return;                               // already adopted
  const legacy = yield* userVersion(sql);                           // SQLite only; 0 on a fresh store
  if (legacy === 0) return;                                         // fresh store: let the ladder run
  yield* sql`INSERT INTO boot_migrations ${sql.insert(
    Array.from({ length: legacy }, (_, i) => ({ migration_id: i + 1, name: `legacy_v${i + 1}` })),
  )}`;
});
```

Three properties this must have, each deserving its own test against a fixture database:

1. It is a no-op on a store that already has a stamped ledger, so it is safe to run on every boot.
2. It is a no-op on a fresh store, so a new deployment runs the real migrations.
3. The stamping insert runs in the same transaction as the migrator that follows, so a crash between stamping and migrating cannot leave a half-adopted ledger. The ledger's `CREATE TABLE IF NOT EXISTS` runs *before* that transaction, for the Postgres reason in section 7.1; it is idempotent, so a crash after it costs nothing.

`user_version` is a SQLite concept, so the adopt step is SQLite-only by construction: a Postgres or MySQL deployment is always fresh from comms' point of view, since there is no pre-existing remote store to adopt.

This is where a mistake is expensive, because it touches a user's existing volume. Test it against a real v14 fixture, not a synthesised one.

### 7.4 "Refuse a newer store"

`SPEC.md` §9 requires that a new image refuse to start on a `boot.db` from a *newer* bootloader. That is implemented today as `version > 14` at `packages/boot/src/boot-schema.ts:34`, raising `BootSchemaTooNew`. It becomes a max-applied-id comparison, which comms issues itself: `SELECT migration_id FROM <table> ORDER BY migration_id DESC LIMIT 1`, the same query `Migrator` runs internally at `Migrator.ts:162-175`. `latestMigration` is a local binding inside `Migrator.make`'s generator and is not exported (`grep -n "^export" Migrator.ts` lists `MigratorOptions`, `Loader`, `ResolvedMigration`, `Migration`, `MigrationError`, `make`, `fromGlob`, `fromBabelGlob`, `fromRecord`, `fromFileSystem` and nothing else), and `make`'s return value is only the migrations *this run* applied (`Migrator.ts:112-113`, `:302`), which is empty on an already-current store — exactly the case the check exists for. Run the comparison before the migrator, alongside the adopt step. The rule becomes "the highest applied migration id exceeds the highest id shipped in this image". The app store has the same shape today at `packages/server/src/kernel/database.ts:20`, raising `app_schema_unsupported`, and moves the same way.

### 7.5 The Postgres integer codec

Postgres `int8` decodes to a JavaScript `bigint`, unconditionally: the codec at `repos/effect/packages/sql/pg/src/PgTypes.ts:1237-1249` reads eight bytes and returns `scratchView8.getBigInt64(0)`, and `SqlClient.SafeIntegers` (`SqlClient.ts:385`) is read only by the sqlite adapters (`sqlite-bun/src/SqliteClient.ts:160`, `:173`). Every `Schema.Int` decoder in comms would then fail, and there are hundreds. Epoch milliseconds are around 1.7e12, well past `int4`, so the columns genuinely need `bigint`.

The fix is one registry, built once in `store.ts` and passed as `PgClient.layer({ types })` (`PgClient.ts:101`, consumed at `PgConnection.ts:243`):

```ts
const intCodecRegistry = PgTypes.makeRegistry();          // PgTypes.ts:1378
intCodecRegistry.register(PgTypes.OID.int8, {             // OID table at PgTypes.ts:282-329
  decode: (bytes) => { /* read int64, Ok(Number(v)) when |v| <= 2^53-1, else Err */ },
  encode: (value) => { /* write int64 from a number or bigint */ },
});
```

`Registry.register` is `<A>(oid, codec, options?) => void` (`PgTypes.ts:382-384`) and `Codec<A>` is `{ encode, decode, write?, read? }` returning `Result.Result` (`PgTypes.ts:876-891`). Narrowing outside the safe range must fail rather than round, which is the same discipline `packages/server/src/kernel/sql-read.ts:47-49` already applies to bigints coming back from the raw SQL route.

One consequence for that route. Today `sql-read.ts:39` provides `SafeIntegers` and `:47-49` narrows; on Postgres the registry narrows first, so `:47-49` becomes unreachable there, and an out-of-range `int8` in an agent's arbitrary `SELECT` surfaces as a `SqlError` from the codec, which `:40` maps to `query_invalid`, where on SQLite it is the typed rejection at `:50-57`. The observable code is the same; the message is not, and the pglite suite gets a case for it so the difference is chosen rather than discovered.

`bytea` needs nothing: its codec returns a `Uint8Array` (`PgTypes.ts:1174-1180`), which `Schema.Uint8Array` at `packages/boot/src/source-schema.ts:30` accepts. `Statement.ts:1136` classifies `Uint8Array` as a primitive kind, so all three drivers bind blobs on the way in.

### 7.6 Agent-authored migrations

`packages/server/src/migrations/README.md:3` already requires "a default-exported Effect requiring only `SqlClient`", so agent-authored migrations get `sql.onDialect` for free. The README gains one paragraph:

> If your deployment might run on more than one engine, branch DDL with `sql.onDialectOrElse({ orElse, sqlite, pg, mysql })`. The comms helpers in `kernel/dialect.ts` already cover prefix matching, JSON reads, upserts and null-safe comparison; reach for `onDialectOrElse` only for DDL those do not cover, such as column types and index kinds. Integer booleans must stay integer on every engine: `Schema.Literals([0, 1])` decoders exist throughout the kernel and a native boolean column breaks them at runtime. A migration without a branch for an engine makes the board non-transferable to that engine (section 15.6); `store-transfer --check` tells you which one. On MySQL, a stored procedure, function or event you create is not carried by backups, rehearsal clones or transfers.

The README's closing sentence about the built-in bootstrap and its `user_version` (`README.md:15`) also changes, because after step 4 there is no `user_version` and no separate bootstrap.

### 7.7 The one idempotency table

`pr-comments.md` item 9 folds the four idempotency tables into one, `idempotency(instance, key, kind, input_hash, outcome)`, as part of the `mutate()` combinator; the working tree already has that shape (`database.ts:87`). One table means one set of per-dialect DDL and one `upsert` call site instead of four, and the `input_hash` comparison is a plain text equality that is identical on every engine. Do not re-introduce per-operation idempotency tables while porting.

---

## 8. Search

Search is the `q` parameter of `GET /api/messages` (`packages/server/src/conversation.ts:26`, described at `:42-45`), implemented inside `messages.list` at `packages/server/src/kernel/messages.ts:207-224`. The index maintenance and the match fragment move behind a `Search` service with three implementations; the route and its contract do not move.

### 8.1 SQLite: FTS5 keyed on message id

Today the index is joined on `rowid` (`packages/server/src/kernel/database.ts:60-64`). Neither Postgres nor MySQL has an implicit row identity, and `messages.id` is already `TEXT PRIMARY KEY` (`database.ts:35`) and already carried as `message_id UNINDEXED` in the FTS table (`:60`). So the first change is SQLite-only and is a simplification:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED, body, previous_body,
  tokenize='unicode61 remove_diacritics 2');

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id,body,previous_body)
  VALUES(new.id,new.body,json_extract(new.previous,'$.body')); END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF body,previous ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id=old.id;
  INSERT INTO messages_fts(message_id,body,previous_body)
  VALUES(new.id,new.body,json_extract(new.previous,'$.body')); END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id=old.id; END;
```

The startup shape probe at `database.ts:85` stays.

### 8.2 Postgres: generated `tsvector` columns plus GIN

```sql
ALTER TABLE messages
  ADD COLUMN body_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body,''))) STORED,
  ADD COLUMN previous_body_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(previous->>'body',''))) STORED;
CREATE INDEX messages_body_tsv ON messages USING gin (body_tsv);
CREATE INDEX messages_previous_body_tsv ON messages USING gin (previous_body_tsv);
```

Generated columns require an immutable expression. `to_tsvector(regconfig, text)` with a literal configuration is immutable, so this is legal; the one-argument `to_tsvector(text)` is not, because it reads `default_text_search_config`. Always pass `'simple'` explicitly.

The query side is **not** `websearch_to_tsquery`. That function never raises on arbitrary input, which is the safety property the hand-rolled quoting at `messages.ts:209-217` provides on SQLite, and it ANDs adjacent words and honours double-quoted phrases; it also implements the rest of the web-search syntax, which the contract forbids: a bare `or` becomes a disjunction and a leading `-` becomes negation, where SQLite's `:217` re-quotes every part and so treats both as literal terms. comms has already parsed the caller's text into `parts` at `:209`, so the Postgres query is built from that array: one `phraseto_tsquery('simple', part)` per quoted phrase, one `plainto_tsquery('simple', part)` per bare term, joined with `&&`, and matched as `body_tsv @@ <tsquery>`. Both functions are total on arbitrary input too, so the never-raises property survives and no operator the caller did not ask for is interpreted.

**Diacritic folding is the one divergence that needs a decision.** SQLite's `remove_diacritics 2` folds accents. The Postgres equivalent is the `unaccent` extension, which is `trusted` from PG13 so a role with `CREATE` on the database can `CREATE EXTENSION unaccent` without superuser, wrapped in an `IMMUTABLE` SQL function so it can appear in a generated column. The app role has that privilege on the live database and on every clone because clones are created `OWNER comms_app` (section 3.2). If a provider forbids the extension, fall back to `'simple'` without folding and document it. Decide per deployment; default to attempting the extension and degrading with a logged warning, never failing startup.

### 8.3 MySQL: two `FULLTEXT` indexes

```sql
ALTER TABLE messages ADD COLUMN previous_body TEXT
  GENERATED ALWAYS AS (NULLIF(previous ->> '$.body','null')) STORED;
CREATE FULLTEXT INDEX messages_body_ft ON messages(body);
CREATE FULLTEXT INDEX messages_previous_body_ft ON messages(previous_body);
```

Two separate indexes, not one two-column index, because `MATCH … AGAINST` in a multi-column full-text index cannot express per-column matching, and the published-image trick needs exactly that: the current body for rows at or below the fence, the previous body for rows above it (`messages.ts:218-223`).

Query safety has two halves on MySQL. First, strip the boolean operators `+ - > < ( ) ~ * " @` from caller terms and re-quote phrases, as on SQLite. Second, and this is the half that is easy to miss, prefix every surviving term and every re-quoted phrase with `+`: boolean mode treats an unprefixed term as *optional* and combines terms with OR, so without the `+` a two-term search returns everything matching either term, which is not a degradation of the AND contract but a reversal of it. The emitted form is `MATCH(body) AGAINST ('+term1 +"a phrase"' IN BOOLEAN MODE)`. Third, comms reads `@@innodb_ft_min_token_size` and `INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD` once at startup and drops any term the index cannot contain *before* building the expression, so that a required term the engine would never match cannot force an empty page; the caller then gets a superset of the exact answer rather than nothing. Section 12.3 item 12 asserts that a two-term search returns only messages containing both.

### 8.4 The public contract and its documented divergence

`messages.ts:207-217` currently enforces: 1 to 512 characters, at most 16 terms or phrases, every term containing a letter or digit, terms combined with AND, double-quoted phrases, and no raw FTS syntax reaching the engine. That contract holds on all three engines. Two divergences must be written into the `GET /api/messages` description at `conversation.ts:42-45`:

- **MySQL drops short terms.** `innodb_ft_min_token_size` defaults to 3, so a two-character term that SQLite matches is silently ignored. The description must say so rather than leaving an agent to discover it.
- **MySQL drops common words.** InnoDB enables a built-in stopword list by default (`innodb_ft_enable_stopword`), so `the`, `and`, `for` and about thirty other common English words match nothing. SQLite's `fts5` with `unicode61` has no stopword concept, and Postgres's `simple` configuration, which section 8.2 requires for immutability, lowercases and removes nothing, so this is MySQL-only and it is the divergence an agent meets first.
- **Postgres may not fold diacritics** when `unaccent` is unavailable (section 8.2).

Neither is a contract change on SQLite, which remains the reference. The added sentence:

> **Engine differences for `q`: on MySQL, terms shorter than the server's minimum token length (3 by default) and terms on the server's full-text stopword list are dropped from the query, so `ok` and `the` each constrain nothing and the remaining terms decide the result; on Postgres, accented and unaccented forms match each other only when the `unaccent` extension is available. `POST /api/sql` reports the deployment's engine.**

And a matching line in `/init` is wrong: `/init` must stay engine-free, because an agent reading it should not have to know the deployment's backend to write its first query. The divergence belongs in the route description only, which is where `SPEC.md` §12's "the core API is eleven operations" bullet says product detail lives.

**The superset rule is what makes the divergence safe, and it is weaker than "fewer results".** An earlier revision claimed a dropped term produces fewer results and never wrong ones; that is false for a required term in boolean mode, and it was only true at all because SQLite is the reference. The honest statement: every term the engine indexes is ANDed on all three engines, so a result never lacks an indexed term the caller asked for; a term MySQL cannot index (too short, or a stopword) is removed by comms before the query, so the page is a *superset* of the exact answer, never an empty page caused by a term the index could never contain, and never an error. An agent that searches for `the deploy` on MySQL gets every message containing `deploy`. That is a degradation an agent can handle without knowing why; a reversed AND or a syntax error would not be.

---

## 9. Concurrency and isolation

### 9.1 The writer-epoch fence is engine-neutral by construction

`packages/server/src/kernel/database.ts:7-11` is the fence, and it runs at the top of every kernel write transaction. The conditional `UPDATE kernel_writer SET epoch=epoch WHERE singleton=1 AND epoch=?` takes a row lock on every engine (on MySQL as the locking select from section 6.8). Two live writers serialize on that row; the stale one sees zero rows and fails `stale_writer`. Boot installs a fresh epoch the same way at `packages/boot/src/app-recovery.ts:44`.

On Postgres this is *stronger* than it is today, not weaker: the same serialization guarantee without a file-level lock, so transactions that do not touch the fence row no longer wait. `SET epoch=epoch` still takes the lock and still writes a new row version, so the no-op update is not optimised away. With section 9.2's prelude holding no lock, published-image reads no longer wait either, which is the read concurrency section 14.5 counts as a remote-engine gain.

**Postgres write transactions must stay at READ COMMITTED.** This is the trap, and it is Postgres-specific. Under Postgres `REPEATABLE READ`, a concurrent `UPDATE` on a row another transaction has modified since the snapshot blocks and then raises a serialization failure (`40001`) rather than returning zero rows, so every concurrent write would surface as a retriable serialization error instead of the typed `stale_writer` the kernel expects, and the fence's whole purpose — telling a stale process that it is stale — would be defeated. MySQL does not share the hazard even though InnoDB defaults to `REPEATABLE READ`: a locking read or `UPDATE` there performs a current read, waits for the X lock, and re-evaluates its `WHERE` clause against the latest committed row, so the stale writer matches zero rows exactly as it does at READ COMMITTED. Apply the isolation prelude in section 9.2 to read transactions only. Never to `mutate()`.

### 9.2 The read snapshot: the subtlest thing here

`packages/server/src/kernel/published-messages.ts:4-5` states the rule: "Capture a SQL snapshot before reading boot's fence. Serialized writes publish before starting another mutation, so that snapshot can contain at most one unpublished image." Seven read paths open with a throwaway `SELECT epoch FROM kernel_writer` to take that snapshot and then read the fence: `packages/server/src/kernel/messages.ts:179` and `:243`, `pages.ts:38` and `:88`, `topics.ts:40`, `extension-data.ts:63`, `extension-capabilities.ts:74`. (`page-write-policy.ts:44` also selects from `kernel_writer`, but as a write-side epoch check, not a read snapshot.)

On SQLite this works because `sql.withTransaction` issues `BEGIN IMMEDIATE` on a writable connection (`repos/effect/packages/sql/sqlite-bun/src/SqliteClient.ts:238`, module doc at `:7-9`), which takes the write lock for the transaction's whole duration even when it only reads. No writer can commit while the read runs, so every statement in the transaction sees the same rows.

**What the rule actually needs is a consistent snapshot, not a lock.** The published-image `CASE` is correct for a row if, at the moment the row was read, at most one mutation of it was unpublished, because `previous` holds exactly one prior image and every prior image was published before the next mutation began (the writer is one process holding `mutex`, and `mutate()` appends to boot before it returns). That invariant is a property of the writer, not of the reader's lock. Given it, for any consistent snapshot and any fence value read from the process's own cache: a row whose `updated_seq` is at or below the fence shows `body`, which its last mutation published; a row above it shows `previous`, which the mutation before that one published. Neither branch can show an image that was never published. An earlier revision of this document argued that `REPEATABLE READ` alone was insufficient and required `SELECT … FOR SHARE` on `kernel_writer`; the scenario it feared, two unpublished images of one row, violates the writer invariant and cannot arise, and the lock it prescribed would have serialized every published-image read behind every write (and, worse, held a row lock across the fence's HTTP round trip on a cold cache). The lock is gone.

Two things do have to hold, and the prelude provides the first:

1. **All statements in one read path must see one snapshot.** `list` runs several statements (topic checks at `messages.ts:100`, the mention and body subqueries, the page query). Under Postgres READ COMMITTED each statement gets its own snapshot; under REPEATABLE READ the first statement pins one for the transaction, and InnoDB's REPEATABLE READ does the same on its first consistent read. Within a single statement both engines are already consistent, so the failure at READ COMMITTED would be a topic archived between two statements, not an unpublished image; it is still the wrong answer, and the prelude closes it.
2. **The fence must be the process's own.** The fence is cached per child and advanced by the child's own `append` (`packages/server/src/kernel/boot-channel.ts:141-146`, `:164-178`), so it can never be ahead of what this process has published and is fetched from boot only once, when the cache is cold. That single fetch is an HTTP call inside an open transaction that holds no lock; the child primes the cache during startup (before `initialize` at `database.ts:12` returns) so no request pays it.

| Engine | Prelude, as the first statement inside the transaction |
| --- | --- |
| sqlite | none (`BEGIN IMMEDIATE` is already stronger); the `SELECT epoch FROM kernel_writer` stays as belt and braces |
| pg | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` |
| mysql | none per transaction, because `SET TRANSACTION` cannot be issued inside one (section 5.2); the server default is `REPEATABLE-READ`, and boot asserts `SELECT @@transaction_isolation` at startup and refuses `store_isolation_unsupported` when an operator has changed it |

`SET TRANSACTION ISOLATION LEVEL` must precede any query in the transaction, which is why it comes first and why `readTransaction` must skip the whole prelude when nested (section 6.9). `SqlClient` fixes `beginTransaction` per client at `SqlClient.ts:171` and `withTransaction` takes no options (`SqlClient.ts:57-59`), so the isolation level cannot be a client option or a call argument. It has to be a first statement.

**A missing prelude is silent.** One read path that forgets `readTransaction` loses cross-statement consistency with no error and no failing test, which is the same failure shape section 6.7 calls the worst in the list. Section 12.3 therefore includes a compiled-SQL assertion that each of the seven sites opens with the prelude, and a container test that a reader never sees an unpublished image while a writer commits and publishes two edits to the same message.

**This is a correctness argument, not an observed failure.** It deserves the concurrency test on a real Postgres and a real MySQL before anyone trusts the port. See sections 12.3 and 16.

### 9.3 The `seq` allocator and the edit lock are read-modify-write on a singleton

`packages/boot/src/events.ts:176-210` reserves a range in one boot transaction: it reads the `seq` singleton through `state` (`:55-59`) at `:181`, checks `pending_id` at `:203`, and writes `event_batches` and `seq` at `:206-207` with values computed in JavaScript from that read. `append` (`:80`), `abort` (`:164`) and `writeBoot` (`:218-221`) have the same shape, and `writeBoot` inserts `events(seq=current.next)` against `events.seq INTEGER PRIMARY KEY` (`:49`). The edit lock's `admit` (`packages/boot/src/edit-lock.ts:141`) reads the `edit_lock` singleton and upserts a row derived from it at `:233`.

**On SQLite these are atomic only because of the file lock.** `BEGIN IMMEDIATE` makes every boot transaction serial from its first statement, so the read and the write cannot interleave with another transaction's. On Postgres at READ COMMITTED, which section 9.1 requires for writes, a plain `SELECT` takes no lock, so two transactions can both read `next = 100`: a request-event `writeBoot` and the app's `reserve` then both claim `100`, one `INSERT` violates the primary key, and which one loses decides whether a diagnostic event is dropped or an already-committed app mutation can never be published. On InnoDB at REPEATABLE READ the plain `SELECT` is a consistent non-locking read and the hazard is identical.

R14 is the rule: every boot transaction that reads a singleton and writes a value computed from it takes the row exclusively first. The mechanism is one helper, `lockRow(sql)`, which emits nothing on SQLite and `FOR UPDATE` on Postgres and MySQL, appended to the `state` query used inside `reserve`, `append`, `abort` and `writeBoot`, and to the `edit_lock` read inside `admit`. The read-only uses of `state` (`changed` at `:71`, `query` at `:237`, retention at `event-retention.ts:19`, restore at `database-restore.ts:185`) stay unlocked. Every other statement in the allocator is portable, and off SQLite the contention narrows from the whole boot store to two rows, which is the improvement the earlier "only engine coupling is contention" sentence was reaching for. Section 12.3 item 9 is the container test: a concurrent `reserve` and `writeBoot` must yield two distinct sequence values and exactly one outstanding reservation.

### 9.4 Bounded network calls inside the write lock, and the freeze budget

`SPEC.md` §6.3 requires that network calls made while holding the SQL write lock are bounded, and `packages/server/src/kernel/boot-channel.ts:117` enforces a 1500 ms default timeout on every boot call. `boot.reserve` (`:200`) is called from inside `sql.withTransaction` during a mutation. No boot HTTP call is made while a `kernel_writer` or `seq` row lock is held on the *read* side: section 9.2 holds no lock, and section 9.3's locks are inside boot's own transactions, which make no HTTP calls.

On SQLite the global write lock is held across one HTTP round trip to boot. On Postgres it is one row lock held across the same round trip, which is better. On a remote engine it is held across two network hops instead of one: app to boot over localhost, and app and boot to the database over the network.

**The freeze budget is a sum, not a per-mutation number.** `packages/boot/src/cutover.ts:181-194` puts one `Effect.timeoutOrElse` of 10 seconds around `traffic.drained`, and admitted mutations serialize on the writer fence, so the drain is the sum of every admitted mutation's remaining time. One remote mutation costs the epoch gate round trip, `boot.reserve`, the domain writes, the batch and outbox inserts, the commit, and `POST /_boot/events/append` (`boot-channel.ts:201`) before it acknowledges. Four admitted mutations at 2.5 s each exceed the budget. The rule for a remote deployment is therefore `FREEZE_BUDGET >= max admitted mutation concurrency × worst-case mutation latency`, both of which comms controls: the freeze budget is configuration (`FREEZE_BUDGET`, default 10 s, the value `SPEC.md` §7.7 step 4 names), and the number of concurrently admitted mutations is bounded by the mutation gate. Exceeding the budget is safe and already implemented: the cutover is abandoned before the backup, queued writes are released to the live child, nothing is lost, and the edit returns `freeze_timeout` (`cutover.ts:190-193`, `:319`). What it costs is that an agent cannot land an edit while the board is busy, and section 16 item 6 makes measuring that a pass/fail criterion rather than a number to record.

### 9.5 The outbox stays; `SECURITY DEFINER` is rejected

With both stores on one engine, it is technically possible to eliminate the outbox by having the app's transaction append directly to boot's event log through a `SECURITY DEFINER` function owned by the boot role, with `EXECUTE` granted and no table grant. That would collapse the `outbox` table, the relay loop, the `mutation_batches` receipts, the reconciliation at `packages/boot/src/app-recovery.ts:46-101`, the `event_batches` state machine at `packages/boot/src/events.ts:77-210`, the replay dedup at `:107-119`, and the abort-on-typed-failure dance in every write path. Several hundred lines and most of the hardest reasoning in the codebase.

It is rejected, for three reasons.

1. **It holds in none of the three deployment shapes.** Postgres and MySQL both refuse cross-database transactions without two-phase commit, so with R2's two databases it is impossible; it would only have worked under the one-database fallback that section 3.4 now rejects. The outbox code must exist for SQLite regardless. You would be maintaining two publication protocols, and `SPEC.md` §12's "Events are a bootloader-owned primitive with a transactional outbox" would become conditional.
2. **An editing agent would have two mental models** for how a write publishes, selected by a deployment flag it cannot see from the code.
3. **Reconciliation is not only about the outbox.** It is also how recovery decides whether an interrupted transaction committed, and `SPEC.md` §6.3 requires that decision to be made from committed evidence in the app store. An atomic append removes the ambiguity for the common case but not for the crash-mid-commit case.

If the owner later wants the simplification, it should arrive as a spec change with its own review, not as a side effect of choosing Postgres.

### 9.6 One writer process; multi-container is unsupported

The blue-green design in `SPEC.md` §7.1 assumes one box: one bootloader owning the public port, one live child, one candidate. Putting the store on Postgres does not make the app horizontally scalable, and this design does not attempt it. Two bootloaders against one `comms_app` database would each mint epochs and each believe they own the fence; the fence would correctly reject one of them, but the edit lock, the generation counter, the snapshot directory and the keeper receipts are all per-box.

State it explicitly, in `SPEC.md` §9 and in `docs/deployment.md`, and remove "multi-container hosting" from `docs/tech.md:116`: **a Postgres deployment still runs exactly one comms container.** Multi-container is unsupported until someone designs the leader election it needs, and that is a different project.

### 9.7 Session timeouts around DDL

`ALTER TABLE` on Postgres needs `ACCESS EXCLUSIVE`, and every read transaction holds `ACCESS SHARE` on the tables it touched until it commits. A queued `ACCESS EXCLUSIVE` request also blocks every *later* lock request on that table, so a single in-flight read does not merely delay a candidate's migration, it makes every read arriving after it queue behind the migration. `SPEC.md` §7.7 step 4 promises "reads keep flowing to the live child" and step 6 gives the candidate five seconds from `go` to health (`cutover.ts:223-230`); on Postgres those two promises meet exactly here. The read transactions are short (the long-poll waits on boot outside the transaction, `boot-channel.ts:148-163`), so the window is small, but it is not zero and no rehearsal can reproduce it, because the rehearsal clone has no concurrent readers.

Three session-level settings, set by `Store.clientLayer` through the URL's `options` on Postgres and by a first statement on MySQL:

| Setting | Candidate's migration session | App read sessions |
| --- | --- | --- |
| Postgres `lock_timeout` | 1 s: a migration that cannot get its lock fails the cutover promptly, step 8 restores, and the reads it was queued behind proceed | unset |
| Postgres `statement_timeout` | 4 s (inside the 5 s deadline) | 5 s, so a stuck read cannot hold `ACCESS SHARE` for the life of a long-poll |
| MySQL `lock_wait_timeout` / `innodb_lock_wait_timeout` | 1 s | default |

Section 14.1 records the residual: on Postgres and MySQL, "reads keep flowing" is weakened for up to `lock_timeout` during a DDL migration, and the compensation is the short timeout plus the step-8 restore.

---

## 10. Backups, restore, drills, budgets

### 10.1 Pre-flip backup

`packages/boot/src/cutover.ts:195-222` freezes, drains, installs the prior epoch, reads `published_through`, clones (`:203`), and records `{id, path, reason, bytes, taken_at, published_through, generation}` plus a `backup.taken` event and the cutover row in one boot transaction (`:204-221`). The hourly path does the same at `packages/boot/src/scheduled-backup.ts:55-95`.

The guarantee, stated at `SPEC.md` §7.7 step 8, is "since writes were frozen and drained before the backup, the restore loses nothing". That rests on the freeze and the drain, not on the copy mechanism. So `pg_dump -Fc` after the drain is exactly as consistent as `VACUUM INTO` after the drain, and `mysqldump --single-transaction` on an all-InnoDB store likewise, given that the dump runs as a role that can read every table, which section 3.2's membership guarantees. Only the producer behind `DbOps.backup` changes. **No guarantee weakens here.**

### 10.2 What a `backups` row means when `path` is a dump

The `backups` schema gains one column, `engine`, stamped at capture from `DbOps.dialect`. `path` becomes "path to the restorable artefact on the volume", which is a database file on SQLite and a dump on Postgres and MySQL. `bytes` is the artefact's size, which on a compressed `pg_dump -Fc` is smaller than the database; that is fine, because the 20% budget in `SPEC.md` §7.5 is a budget on the volume, and the artefacts are what occupy the volume.

**Three validations hardcode `${id}.db`, not two.** `packages/boot/src/database-restore.ts:40-58` (`:51` and `:53`) and `packages/boot/src/cutover.ts:65` on the rollback path all compare the catalogued path against `backups/<id>.db`. All three become extension-aware by engine: `${id}.db`, `${id}.dump` or `${id}.sql`. Keep the `realPath` check at `database-restore.ts:52-53` exactly as it is; it is what stops a symlinked artefact pointing outside the backups directory.

**The backups directory comes from `DATA_DIR`, never from the store.** Three sites derive it as `path.join(path.dirname(recovery.filename), "backups")` (`database-restore.ts:46`, `:251`, `scheduled-backup.ts:62`), and `path.dirname("postgres://…")` is meaningless. `cutover.ts:199` already uses `dataDirectory`; the other three follow it.

**Cross-engine restore is not supported, and it is refused rather than attempted.** `backups` rows survive a transfer (section 15), and after a SQLite-to-Postgres move the list is full of `.db` files a Postgres `restoreInto` cannot read, including the newest one the drill picks first. `POST /_boot/db/restore`, the cutover rollback and the drill all refuse an artefact whose `engine` differs from the deployment's with `backup_engine_mismatch` and a message pointing at the transfer tool; `GET /_boot/db/backups` shows the engine on every row. Section 15.5 states the cliff plainly: an engine change makes every prior artefact non-restorable, and the first pre-flip or hourly backup on the target is the first restorable one.

### 10.3 Restore, and the durable identity of the live store

`packages/boot/src/app-backup.ts:35-46` is the close-handle protocol, and the comment at `:41` is the load-bearing one: "The caller has positive closure evidence for every process that could own these handles."

On Postgres and MySQL, `restoreInto` restores into a *fresh* database and returns a new descriptor. That is structurally safer than renaming, because nothing is ever mutated under a live reader. It also changes something that on SQLite is a constant: **which database is the board.** Today that identity lives in `AppRecovery.filename`, fixed when the layer is built (`app-recovery.ts:19`, `:25`), read by `supervisor.start` (`supervisor.ts:189-192`), and unchanged by a restore because `restore` replaces the bytes behind it. Every restore path discards `backup.restore`'s result (`cutover.ts:73`, `database-restore.ts:109`, `:123`) and the next `launch` and `recovery.prepare` use the old descriptor. On a remote engine that would start the child against the *pre-restore* database at the very next step, and a container restart would do the same from `DATABASE_URL`. R13 closes it:

- **Identity is adopted in two phases, because two stores cannot share a transaction.** Boot first commits an `app_store_adoption` record in the boot store, the minted UUID, the timestamp, the canonical store selection and `phase: "pending"`, in a boot transaction of its own. The app transaction then writes or verifies `store_identity`, before the writer fence changes, accepting an absent row only while the adoption is pending. Only after the app store and its parent directory are fsynced does boot commit the finalizing transaction that writes `app_store_id`, the `app_store_initialized` marker and `phase: "ready"`. An interrupted adoption resumes the reserved UUID rather than minting a second one. Writing the two halves without this reservation wedges the board on one SIGKILL in either ordering: the surviving half names an identity the other half will never agree with, and every subsequent start fails `app_store_missing` with both stores intact. A malformed or self-contradictory adoption record is the distinct `app_store_identity_invalid`, which is not the same failure as a store that is merely absent. (From PR #3, 2026-09-11; it replaces the single-transaction wording an earlier revision used.)
- **The boot store journals the live app database's name.** A `settings` row, `app_store_database`, seeded from `DATABASE_URL`'s path when the store is first initialised (the transaction that writes `app_store_initialized` at `app-recovery.ts:109`) and rewritten by `restoreInto` **in the same boot transaction that records the restore phase** (`cutover.ts:75`, `database-restore.ts:127`). Only the name is journaled; the credential and server stay in the environment.
- **Boot starts from the journal.** Once `app_store_initialized` exists, the descriptor boot uses is `withDatabase(env, journaled name)`; the URL's path is reported by `/_boot/status` next to the live name and otherwise ignored, with an `info` log when they differ. An operator who wants a different database runs the transfer (section 15) or a restore; nothing else moves the pointer, and nothing outside comms can move it back.
- **`AppRecovery.store` is a `Ref`**, seeded from the journal at start and set by `restoreInto`, so `supervisor.start`, `cutover.ts:176`, `database-restore.ts:129` and every `recovery.prepare` read the current identity rather than a constant. On SQLite the `Ref` never changes and `restoreInto` returns what it was given.
- **The rendered child descriptor follows it**: `APP_STORE` is the app credential plus the journaled name, so a child started after a restore, or after a restart, opens the restored store.

**`app_store_missing` gets a remote form.** Today `prepare` reads the marker and `fs.exists(filename)` (`app-recovery.ts:28-30`) and fails `app_store_missing` when the marker exists and the file does not; `cutover.ts:143` has a second `fs.exists`. Neither has a remote meaning. The replacement is the `store_identity` row from section 3.5: `prepare` reads it from the app store and compares `store_id` with the boot store's `app_store_id`. Marker present and row absent or different is `app_store_missing` (the environment or the journal names a database that is not this board, including an empty one that would otherwise be silently re-initialised and hand out sequence numbers from `seq.next` that already name messages nobody can see). Store unreachable is the distinct, retriable `store_unreachable`, which never takes the initialisation branch. Marker absent is the fresh-store branch, which mints the id and writes both halves. This is a behaviour change in step 1, and section 13 says so.

**Backups taken before identity existed.** Every artefact a deployment already holds was copied from a store with no `store_identity` table, and refusing all of them at upgrade would destroy the restore history the whole section exists to protect. At the moment boot adopts a pre-identity store it records, on each SQLite backup row already in its catalogue, the identity being adopted (`backups.legacy_store_id`), in the same transaction that finalizes the adoption and only where the column is still null. A restore may create `store_identity` on its private staging copy only when that column equals the live identity; every other artefact must already carry a matching row, and one carrying a different `store_id` is refused whatever the column says. The catalogued artefact's own bytes are never modified. This exception closes permanently the first time boot completes an adoption: no backup taken afterwards can receive it. (From PR #3, with the stamp moved into the finalizing transaction per the stack review.)

**Closure evidence is still required, on every engine.** If an orphaned child still holds a connection to the abandoned database and keeps committing, those writes are acknowledged and then silently lost when the pointer moves. That violates the spec's hardest invariant, and it is not a SQLite artefact. So the keeper, the receipt file, and the `child_attempts` bookkeeping survive unchanged, and `supervisor.assertClosure` stays where it is at `packages/boot/src/database-restore.ts:215`, `:280`, `:286` and `packages/boot/src/scheduled-backup.ts:24`, `:99`.

Postgres offers a belt-and-braces second check SQLite cannot: `REVOKE CONNECT ON DATABASE <old> FROM PUBLIC, comms_app` followed by `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '<old>'`, which `comms_boot` may run because it is a member of `comms_app` (section 3.2). Use it **as a second check, never as a replacement for the receipt**, because a terminated backend may have committed before it died. The receipt proves the child observed its own shutdown; termination proves only that the connection is gone now.

**The restore path runs migrations with no rehearsal, and on MySQL that matters.** `database-restore.ts:114-167` launches a candidate from the current good generation against the just-restored store (`:129`) and gives it five seconds to health (`:136`); the child's startup runs `Migrator` (`migrations.ts:45-49`) to bring the restored schema forward to the running source's. No rehearsal runs against the restored content, and the only backup in hand is the pre-restore safety copy, which is the state the human is trying to leave. On SQLite and Postgres a forward migration that fails on the restored rows rolls back and the restore fails cleanly; on MySQL it leaves the restored store half-migrated (section 14.4 item 1) and the rollback puts back the store with the destroyed rows, so the human's restore fails identically on every retry. So the restore path gains the rehearsal the cutover already has: before `install` activates the candidate, clone the restored target with `cloneForRehearsal` and run the real-candidate self-test against the clone through the same `launch(…, "rehearsal")` seam, failing the restore with `restore_rehearsal_failed` when the forward migration does not apply. Section 12.3 item 3 covers it.

**Restore uses the freeze gates, and every release must stay in `Effect.ensuring`.** At the working tree the request-gate release is `release` at `database-restore.ts:89-92`, attached at `:307` as `Effect.ensuring(release)` with a `tapCause` unroute at `:300-306` before it, so `pr-comments.md` item 24 point 1 is fixed. `restoreInto` returning a new descriptor adds a failure path between the freeze and the pointer switch (a `pg_restore` that fails partway, leaving `comms_app_<n>` half-loaded and the journal untouched), and that path must be covered by the restore failure-mode suite: the gate releases, the journal still names the previous store, the half-loaded target is left for diagnosis and listed by `/_boot/status`.

### 10.4 Drills

The weekly drill left boot in commit `c6f2a14`, per `pr-comments.md` item 21 ("a schedule plus a rehearsal"), so `packages/boot/src/backup-drill.ts` no longer exists. In the target shape the drill is an app-side cron that calls boot mechanisms over the existing routes. Its engine-neutral form:

1. `GET /_boot/db/backups` to pick the newest artefact whose `engine` matches the deployment.
2. A new `POST /_boot/db/drill {backup}` that runs `DbOps.restoreInto` against a *scratch* target rather than the live one (so it does not touch the journal), launches a rehearsal child at that descriptor through the `supervisor.launch` seam, and returns the self-test outcome.
3. `dropClone` on proven closure; leave the scratch in place otherwise, and emit `backup.drill` with the outcome either way.

On SQLite the scratch is a temp file under the data directory, as before. On Postgres it is `comms_drill_<n>`, on MySQL the same. "Leave the scratch behind when closure is unproven" becomes "leave the scratch database behind", which is why `reapClones` exists.

### 10.5 The reaper

A repeatedly failing drill or rehearsal accumulates databases, which a file-based store never did because a failed drill left one file that a human could see with `ls`. `DbOps.reapClones` runs once on boot start, lists scratch databases matching `comms\_rehearsal\_%` and `comms\_drill\_%` (escaped: an unescaped `_` is a single-character wildcard and would match names the design never created), and drops those not named by a live record. It records what it dropped in one `settings` key so a pattern of repeated reaping is visible rather than silent. About 25 lines and one settings key.

It must **not** drop a scratch whose closure is unproven. The record that says "this clone was abandoned with unproven closure" is what keeps it alive, and the reaper reads it.

It must **never** touch `comms_app_%`. Those are restore targets: the live one is the database the journal names, and its predecessors are the previous boards, one per restore, kept as the way back. `/_boot/status` lists them with their sizes and the restore that superseded each; a human drops them. That is the one place a remote deployment needs a hand where SQLite did not, because on SQLite the pre-restore state survives only as the safety backup on the volume.

### 10.6 Budgets

`SPEC.md` §7.5 budgets four things against the volume: backups at 20%, snapshots to the last five good generations plus the live one, events under a 10% cap, and a refusal of any write that would leave less than 5% headroom so a delete always has room to record itself. `/_boot/status` shows usage against each.

R1 moves **both** stores, so with a remote engine the rows that used to occupy the volume — `versions.content` and `previous_content`, `staging.content`, `source_changes` (up to 1 MiB each per `SPEC.md` §7.5) and the whole `events` table — live on a server whose capacity R9 says is unknown. Each budget therefore has a volume part and a store part:

| Budget | Volume part (unchanged) | Store part on a remote engine |
| --- | --- | --- |
| Backup artefacts at 20% | Dumps are still files on the volume, catalogued in `backups` with `bytes` | none |
| Snapshots to five good generations | Source trees under `/data/gen` | none |
| Events under a 10% cap | nothing on the volume any more | An absolute byte cap, `EVENT_BYTES_CAP`, measured as `SUM(octet_length(event))` (`SUM(LENGTH(event))` on MySQL) and enforced by `packages/boot/src/event-retention.ts` pruning oldest-first past the cap, in addition to its age policy. On SQLite the default is 10% of the volume, as today; on a remote engine there is no volume to derive it from, so the default is 512 MiB and the operator sets it |
| Versions and staging blobs | nothing on the volume any more | The same shape: `VERSIONS_BYTES_CAP` over `versions.content`, `previous_content` and `staging.content`, enforced by refusing a new version image past the cap with the existing `size_limit` reason (`SPEC.md` §7.5 already has unversioned-but-recorded as a state) |
| 5% headroom refusal | Applies to the volume, where snapshots, dumps and caches still land | **Does not exist.** Boot cannot see the remote disk, so "a delete always has room to record itself" is not a property comms can enforce there; a full server surfaces as `SqlError` on the next boot-store write, which is `/_boot/*` failing. Section 14.2 records this as a loss, and the two caps above are what keeps comms' own rows from being the cause |
| Store size reported by `/_boot/status` | — | `DbOps.capacity` returns `used: Some(pg_database_size)`, `total: None`, for each store, and the status page prints "unknown" for headroom rather than a number it cannot justify |

A bootloader cannot see a managed Postgres volume's free space, and `pg_database_size` gives the database's size, not the disk's capacity. Printing a fabricated percentage would be worse than printing "unknown", and `pr-comments.md` item 21 already makes the parallel point about a status page reporting a budget nothing defends.

This is acceptable against `SPEC.md` §12's three goals, none of which depend on boot knowing the store's free space: an agent recovers from a bad edit by editing again, no acknowledged write is lost, and a broken generation never becomes live. A full remote store surfaces as `SqlError` on a write, and the write response already carries the failure to the agent.

---

## 11. The read-only SQL route

`POST /api/sql` at `packages/server/src/sql-http.ts:9-20` and `packages/server/src/kernel/sql-read.ts` exposes raw dialect SQL by design, and that is the right call: `SPEC.md` §7.4 says an agent doing data surgery gets the real engine, not a portable subset. Four changes.

**Report the dialect.** The endpoint description at `sql-http.ts:18` currently says "Readonly SQLite connection". It becomes dialect-reported, and `SqlReadResult` gains a `dialect: "sqlite" | "pg" | "mysql"` field so an agent can branch without a second round trip.

**Reject the wrong placeholder style with a clear code.** Placeholders are `?` on SQLite (via `Statement.makeCompilerSqlite` at `Statement.ts:1075`) and MySQL (`MysqlClient.ts:464-466`), and `$n` on Postgres (`PgClient.ts:367-369`) and pglite (`PgliteClient.ts:411-415`). So agent-authored SQL with `?` works on two engines and produces a bare syntax error on the third. Add a check next to the existing ones at `sql-read.ts:20-33`: when `params` is non-empty and the SQL contains the other engine's placeholder marker, fail with `KernelError { code: "placeholder_style" }` rather than letting the engine produce something unreadable. The description states which style this deployment uses.

**Keep every statement-count check.** The `^(SELECT|WITH)` test and the semicolon and comment ban at `sql-read.ts:33` bound the *statement count*, not the privileges, so they stay on every engine. The `SELECT * FROM (…) LIMIT 201` wrapper at `:37` needs an alias on MySQL and on Postgres: `SELECT * FROM (…) AS q LIMIT 201`. Emit the alias on all three; SQLite accepts it. (The unaliased derived table the reviews found in `app-backup.ts` is gone with base-work item 21; `published-messages.ts:14` already carries its alias.)

**Read-only enforcement per engine.** Today it is a second connection with `readonly: true` (`sql-read.ts:71`). It becomes `DbOps.readOnlySession`:

| Engine | Mechanism |
| --- | --- |
| sqlite | A second connection with `readonly: true`, unchanged |
| pg | A reserved connection running `START TRANSACTION READ ONLY` … `COMMIT` around the statement (section 5.2) |
| mysql | The same statement on a reserved connection; never `SET TRANSACTION`, which MySQL refuses inside an open transaction |

A dedicated read-only Postgres role would be stronger than a read-only transaction, and it is the right upgrade if the boundary ever needs to resist a determined caller. It is not needed for `SPEC.md` §7.9's threat model, which is mistakes rather than adversaries, and it would add a third credential.

**The write path is unchanged in shape.** `SPEC.md` §7.4 gives writes to `fs` scope with every write statement logged as `sql.write`. That runs on the ordinary write client, under the epoch gate, on every engine.

---

## 12. Testing

### 12.1 What the default suite runs

`bun run test` runs SQLite and pglite. `repos/effect/packages/sql/pglite` wraps `@electric-sql/pglite`, an in-process Postgres with no container: `PgliteClient.layer()` takes an optional config and returns `Layer<PgliteClient | SqlClient, SqlError>` (`repos/effect/packages/sql/pglite/src/PgliteClient.ts:393-395`), and its compiler uses the same `$n` placeholders and `pg` dialect as the real adapter (`:403-415`). Effect runs its full client and migrator suites against it (`repos/effect/packages/sql/pglite/test/Client.test.ts:1-20`). So comms can run its whole Postgres dialect suite in ordinary CI, and pglite is where the parse-time class from section 6.7a fails all at once.

pglite is in-process and effectively single-connection, so it **cannot** exercise the writer-epoch fence with two real writers, nor the allocator race, nor the read-isolation behaviour under concurrency. Those need a container.

### 12.2 Gated container jobs

Copy Effect's own pattern exactly. `repos/effect/vitest.config.ts:11` reads `const integrationTestsEnabled = process.env.EFFECT_INTEGRATION_TESTS === "1"`, and `:51` excludes `**/*.integration.test.{ts,tsx}` unless it is set. The containers come from `@testcontainers/postgresql` and `@testcontainers/mysql` behind a `Context.Service` layer: `repos/effect/packages/sql/pg/test/utils.ts:9-28` builds `PgContainer` with `Effect.acquireRelease` and exposes `layerClient` as `PgClient.layer({ url: Redacted.make(container.getConnectionUri()) })`; `repos/effect/packages/sql/mysql2/test/utils.ts:21-44` does the same for MySQL.

comms uses `COMMS_INTEGRATION_TESTS=1` and the same file-naming convention. Postgres and MySQL get separate jobs, because as `repos/effect/vitest.config.ts:178-184` shows, MySQL starts a fresh container per suite and competes for runners.

**Both container jobs are required, not advisory.** Because all three engines ship, a merge that leaves the MySQL job red is a merge that ships a broken supported deployment. The two jobs run on every pull request that touches `packages/boot/src`, `packages/server/src` or any migration file, and on the default branch on a schedule. The only concession to runner time is that they run after the SQLite and pglite suites pass, so an ordinary mistake fails in 90 seconds rather than after a container pull.

### 12.3 The tests that must run against a real server

These are the reason the container jobs exist. Items 1, 2, 3, 7, 8, 9 and 10 run on Postgres and MySQL both; 4, 5, 6, 11 and 12 are MySQL-specific, because they cover substitutes that have no SQLite or Postgres equivalent to fall back on.

1. **The fence under two writers.** Two processes with different epochs, both running the conditional fence concurrently. The stale one must fail `stale_writer` and must not raise a serialization error (`40001` on Postgres, `1213`/`1205` on MySQL). This proves section 9.1 on both engines, and on MySQL it proves the locking-select replacement reads under the lock rather than after it.
2. **Read isolation under concurrency.** A reader in `readTransaction` while a writer commits and publishes two edits to the same message. The reader must never see an unpublished image, and every statement of a multi-statement read must see one snapshot. This proves section 9.2's argument on both remote engines, and it is what turns that argument into a fact.
3. **A failing migration mid-batch, on MySQL, on both paths.** Two migrations where the second fails. Because MySQL implicitly commits on DDL, the ledger and the partially applied schema both survive the failure. The test asserts that cutover rehearsal rejects the batch before the live store is touched; that a forced failure past rehearsal is recovered by the pre-flip backup rather than left half-applied; that a candidate whose epoch is replaced mid-batch stops before its next migration (section 14.4 item 1); and that a restore whose forward migration fails is refused by the restore-path rehearsal (section 10.3) with the restored target left for diagnosis and the previous store still live.
4. **The partial-index substitute, on MySQL.** Two concurrent attempts to move a source batch into `publishing`; exactly one must succeed, through the generated column's unique index.
5. **JSON null round-trips, on MySQL.** A message with `edited_at: null` in `previous` must decode as `null`, not as the string `null` or as `0`. This is the `NULLIF` rule from section 6.3, and it fails silently without a test.
6. **Collation, on MySQL.** Two ids differing only in case must not collide on a `UNIQUE` index, and a database whose identifier columns carry an accent-insensitive collation must be refused at startup with `store_collation_unsupported`. This is the `utf8mb4_0900_as_cs` requirement from section 3.3, and a server configured with the default collation must fail this test loudly rather than corrupting data quietly.
7. **Roles and ownership across a clone and a restore.** With the checked-in grant script applied: `pg_dump` as `comms_boot` reads a table an agent-authored migration created; a rehearsal child connecting to a clone as `comms_app` can run a migration and the self-test; after a restore into a fresh database the three recovery tables are owned by `comms_boot`, the app's tables by `comms_app`, and the child can serve. The MySQL half checks the same outcomes through the wildcard grants.
8. **Credentials never reach a failure body.** A wrong app password makes every candidate fail to open the store; the write response, `generations.stderr` and `/_boot/status` contain no password and no URL with a credential.
9. **The allocator race.** A concurrent boot `reserve` and `writeBoot` must produce two distinct sequence values and exactly one outstanding reservation; two concurrent edit-lock acquisitions from different families must leave exactly one holder. This proves R14 (section 9.3).
10. **A restore survives a restart.** Restore a backup, take a message, restart boot; the board serves the message. Then a cutover that fails health restores its pre-flip artefact and the prior generation comes back against it. This proves R13 (section 10.3) and the `cutover.ts:65` extension fix (section 10.2).
11. **The isolation assertion, on MySQL.** A server started with `transaction_isolation=READ-COMMITTED` is refused at startup with `store_isolation_unsupported` (section 9.2).
12. **Search on MySQL, and the grant script.** A two-term search returns only messages containing both terms; a search whose terms include a stopword returns the superset section 8.4 describes rather than nothing; `mysqldump` succeeds under exactly the grant script's privileges; and creating `comms_rehearsal_1` as `comms_boot` succeeds while creating `comms_rehearsalX1` fails, which pins the `\_` escape inside the backticked grant pattern.

Cheaper ones belong in the pglite suite: assert the generated SQL text per dialect for `greatest`, `distinctFrom`, `replacePrefix`, `globPrefix` and `tableExists`, which are the helpers that change meaning silently rather than failing loudly; assert that each of the seven read sites opens with the section 9.2 prelude; assert the section 7.5 out-of-range `int8` case on the SQL route; and assert that every migration file in the repository applies on pglite and on SQLite, which catches a missing `onDialectOrElse` branch without a container (MySQL's copy of that assertion lives in its container job, because no in-process MySQL exists).

### 12.4 Fixture consolidation

47 test files construct `SqliteClient.layer` directly at the working tree (28 at the time of the investigation, 39 at the reviews), for example `packages/boot/test/fixtures/events-store.ts`. All of them route through one `packages/boot/test/fixtures/store.ts` that reads the engine from `COMMS_TEST_ENGINE` (`sqlite` by default, then `pglite`, `pg`, `mysql`) and returns the client layer plus a per-test scratch store. One suite then runs on four configurations rather than being written four times.

This is the largest mechanical piece of the testing work and it should happen in step 1, before any second engine exists, because at that point the change is provably behaviour-preserving. It is also what makes steps 5 and 6 tractable: with the fixture in place, adding an engine means implementing it and setting an environment variable, and the entire existing suite becomes the acceptance criterion. Without it, each engine means writing the suite again, which is how a third dialect stops being maintained.

---

## 13. Migration plan

Ordered so the SQLite path stays green at every step. Each step is independently shippable and independently testable. Line counts are the investigation's estimates at ±40%, adjusted where the current head has grown and where the reviews added mechanism.

### Step 0. The spec text — applied

`SPEC.md` §3, §7.5, §9 and two §12 bullets state the one-engine target and the "all three shipped" wording; §9 carries the single-container statement (section 9.6) and the rule that boot, not the environment, records which database is the board after a remote restore (R13); §12's one-engine bullet names comms' own transfer tool rather than a vendor dump (section 15.2). `docs/tech.md` §4's `DbOps` table matches section 5.2 (dump and load only, `comms_rehearsal_<label>`, two databases and two roles with boot a member of the app role, no `TEMPLATE`, no "multi-container hosting"), and §10 lists the two client binaries from section 5.5. Applied 2026-09-11; nothing here gates later work.

### Step 1. Store descriptor and store identity

**Changes.** Add `packages/boot/src/store.ts` with the parser, `dialectOf`, `withDatabase`, `asBoot`, `render`, `redactUrls` and `clientLayer`; implement the `file:` scheme only. Rename `APP_DATABASE` to `APP_STORE`. Replace `AppRecovery.filename` with `AppRecovery.store`, a `Ref`. Add the `store_identity` table and the `app_store_id` and `app_store_database` settings (section 3.5, 10.3), replacing the two `fs.exists` checks. Apply `redactUrls` at `supervisor.ts:78` and `cutover.ts:263`, `:273`. Route the source sites and 47 fixtures through the descriptor.

**Files.** `store.ts` (new), `supervisor.ts`, `app-recovery.ts`, `app-backup.ts`, `cutover.ts`, `boot-channel.ts`, `server.ts`, `sql-read.ts`, `boot-schema.ts` (one migration), plus `test/fixtures/store.ts` (new) and 47 fixture edits.

**Size.** +430, −140.

**Acceptance.** No behaviour change except one, which is tested: a boot store whose marker names a store id that the app store does not carry fails `app_store_missing` before creating any table, and a fresh pair mints and mirrors the id. The suite passes untouched except for fixture imports. A malformed descriptor fails startup with `store_descriptor_invalid` and a message naming the variable. A wrong-password start (section 12.3 item 8, SQLite variant: an unwritable path) produces a failure body with no path inside a URL.

**Must stay green.** Everything. This step is the proof that the seam exists.

### Step 2. Extract `DbOps`

**Changes.** Move `clone`, `prepareClone` and `restore` out of `packages/boot/src/app-backup.ts` behind the interface in section 5.1, with the SQLite implementation moved verbatim. Add `capacity` delegating to `storage-volume.ts`, `tableExists`, `readOnlySession`, `dropClone` and `reapClones` (a no-op list on SQLite beyond stale files). Change `restore` to `restoreInto`, taking an artefact and returning a descriptor, journaling the name in the same boot transaction as the restore phase, and setting `AppRecovery.store`. Add `engine` to `backups`, the three extension-aware validations and the `DATA_DIR`-derived backups directory (section 10.2). Add the rehearsal-copy budget (section 5.3) and the success-path `dropClone` (section 5.4).

**Files.** `app-backup.ts` (absorbed into `db-ops.ts`), `db-ops-sqlite.ts` (new), `cutover.ts`, `scheduled-backup.ts`, `database-restore.ts`, `backup-metadata.ts` (one migration).

**Size.** +280, −80.

**Acceptance.** Zero behaviour change on SQLite: `restoreInto` returns the same descriptor it was given, the journal names `comms.db` before and after, and the supervisor threads it through without noticing. A backup row with a foreign `engine` is refused with `backup_engine_mismatch`. A restore followed by a boot restart serves the restored store (section 12.3 item 10, SQLite variant).

**Must stay green.** The cutover and restore failure-mode suites from `SPEC.md` §7.1.

### Step 3. Extract `dialect.ts` and route the divergent sites

**Changes.** Add the helpers from section 6. They compile to exactly today's SQLite SQL, so the existing suite is the proof. Do `isDescendant` first (41 sites), then `replacePrefix` (4), `upsert` (8), the JSON group (19 occurrences plus the two `json_each` fragments), `nullable` (7), `globPrefix` and the hint helper (5), then the one-site helpers `greatest`, `distinctFrom`, `tableExists`, and `lockRow` (section 9.3), each with a test asserting the generated SQL per dialect. Add `readTransaction` at the seven read sites with the prelude presence test.

**Files.** `dialect.ts` (new), about 18 files in `packages/server/src/kernel`, about 12 in `packages/boot/src`.

**Size.** +260, −120.

**Acceptance.** Byte-identical SQLite SQL for every routed site, asserted by snapshot tests on the silent-change helpers and by the existing behavioural suite for the rest.

**Must stay green.** Everything, and this is the step where "everything" is the whole point.

### Step 4. Both schema bootstraps to `Migrator`

**Changes.** Delete the `user_version` ladders at `packages/boot/src/boot-schema.ts:38-90` and `packages/server/src/kernel/database.ts:23-90`, turning each rung into a migration module. Create both ledgers with `CREATE TABLE IF NOT EXISTS` before any outer transaction (section 7.1). Add the adopt step from section 7.3. Move "refuse a newer store" to the comms-issued max-applied-id query per section 7.4. Update `packages/server/src/migrations/README.md`.

**Files.** `boot-schema.ts`, `auth-schema.ts`, `source-schema.ts`, `refresh-schema.ts`, `cutover-schema.ts`, `enrollment-schema.ts`, `token-mint-schema.ts`, `backup-metadata.ts`, `database-restore-journal.ts`, `event-routing-schema.ts`, `topic-move-schema.ts`, `topic-page-move-schema.ts`, `public-paths.ts`, plus roughly 14 boot migration files and 7 app migration files; `packages/server/src/kernel/database.ts`, `migrations.ts`; the README.

**Size.** +640, −390.

**Acceptance.** An existing `boot.db` at `user_version = 14` boots without re-running anything, proved against a checked-in fixture database. A fresh store builds the same schema as before, proved by comparing `sqlite_master` output before and after. A store stamped one migration past the image refuses to start.

**Must stay green.** Everything, plus a new upgrade test against the v14 fixture. This is where a mistake is expensive, because it touches a user's existing volume.

### Step 5. Add Postgres

**Changes.** Depend on `@effect/sql-pg`. Implement `DbOps` for Postgres with `pg_dump`, `pg_restore`, `CREATE DATABASE`, `DROP DATABASE … WITH (FORCE)`, the access statements per new database, the scratch limit and the escaped reaper patterns. Add `postgresql-client` to the image. Add the `tsvector` search implementation. Add the read-isolation prelude from section 9.2, the `lockRow` emission from section 9.3, the session timeouts from section 9.7, and the freeze-budget configuration from section 9.4. Add the integer codec registry from section 7.5. Add the restore-path rehearsal from section 10.3 and the store-part budgets from section 10.6. Write `packages/boot/sql/postgres-roles.sql` with the membership grant. Stand up the pglite CI job plus the gated container job.

**Files.** `db-ops-pg.ts` (new), `search-index-pg.ts` (new), `store.ts`, `dialect.ts`, `database-restore.ts`, `event-retention.ts`, migration files gaining `onDialectOrElse` DDL, `Dockerfile`, CI config, `postgres-roles.sql` (new).

**Size.** +820, −50.

**Acceptance.** The full suite green under `COMMS_TEST_ENGINE=pglite`. Section 12.3 items 1, 2, 7, 8, 9 and 10 green against a real container. A cutover, a restore, a cutover that fails health and rolls back, and a drill all complete against a real Postgres, and a restart after each serves the right store.

**Must stay green.** The SQLite suite, unchanged.

**Where the surprises will be.** The published-image views, because the `json_extract` to `->>` change alters result types that the decoders at `packages/server/src/kernel/messages.ts:48-52` are strict about; the `int8` codec, because without the registry every integer in the system arrives as a `bigint`; the untyped-null parameters, which fail at parse time on the first pglite run; and the ledger creation order from section 7.1, which fails the first migration on every fresh Postgres store if it is done inside the outer transaction.

### Step 6. Add MySQL — required

**Changes.** Depend on `@effect/sql-mysql2`. Implement `DbOps` for MySQL: `mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF --triggers` for `backup` and for the rehearsal and drill copies, `CREATE DATABASE` plus `mysql < dump` for `cloneForRehearsal`, restore into a fresh `comms_app_<n>` with the journal write for `restoreInto`, `DROP DATABASE` for `dropClone`, and the `information_schema` size query for `capacity`. Add the dialect DDL: `VARCHAR(256)` keys, `LONGBLOB`, `JSON`, `TINYINT` booleans, `AUTO_INCREMENT`, and the generated-column substitute for the partial unique index. Add the locking-select and select-after-write substitutes for all five `RETURNING` statements per section 6.8's table, never branching on affected rows, including the `DELETE`-specific ordering. Add the `CONCAT` forms, the `NULLIF` JSON-null rule and the `JSON_TABLE` mention fragment. Add the two `FULLTEXT` indexes and the boolean-mode query sanitiser. Add the collation assertion over `information_schema.COLUMNS` and the isolation assertion over `@@transaction_isolation`. Wrap each loaded migration with the epoch gate on MySQL (section 14.4 item 1). Write `packages/boot/sql/mysql-roles.sql`. Add `mysql-client` to the image. Stand up the gated container job with the twelve tests from section 12.3.

**Files.** `db-ops-mysql.ts` (new), `search-index-mysql.ts` (new), `store.ts`, `dialect.ts`, every migration file gaining a `mysql` branch, `events.ts` (`distinctFrom`, `replacePrefix`, `globPrefix`), `public-paths.ts`, `topic-move.ts`, `event-retention.ts`, `generations.ts`, `auth.ts`, `database.ts`, `app-recovery.ts`, `migrations.ts`, `Dockerfile`, CI config, `mysql-roles.sql` (new), `conversation.ts` (the contract text from section 8.4).

**Size.** +820, −40.

**Acceptance.** The full suite green under `COMMS_TEST_ENGINE=mysql` against a real container. A cutover, a restore, a rollback and a drill all complete against a real MySQL. The twelve tests in section 12.3 pass. Every weakening in section 14.4 has its named compensation implemented and its test green, not merely documented.

**Must stay green.** The SQLite and Postgres suites, unchanged.

**Where the surprises will be.** The `RETURNING` replacements, because each is correct only under the lock the preceding statement took, the `DELETE` case inverts the order, and the affected-row count lies for a no-op update; and the implicit commit on DDL, which silently voids both the migration batch's atomicity and the epoch gate that wraps it (section 14.4).

### Step 7. Retire per-store engine splitting

**Changes.** Delete the code paths that would allow mismatched engines or mismatched servers. Setting only one of the two URLs, or two URLs that disagree on scheme, host or port, becomes `store_engine_mismatch` at startup rather than a working mixed deployment. One engine choice per deployment, enforced structurally, which is also what makes `asBoot` in section 4.2 sound.

**Size.** +40, −40.

### Step 8. The transfer tool

**Changes.** Implement the engine-to-engine transfer in section 15: a boot-owned offline command that reads both stores through one `SqlClient` and writes them through another, with the in-progress and completion markers, the source stamp, the identity-sequence fixups with their empty-table `COALESCE`, the byte-level verification over every column the board cannot regenerate, the credential-window paragraph in the operator output, `--check`, and the refusal to run while a child is alive or a reservation is pending.

**Files.** `packages/boot/src/store-transfer.ts` (new), `packages/boot/src/index.ts` (the command entry), `app-recovery.ts` (the `store_transferred` and `store_transfer_incomplete` refusals).

**Size.** +420, −0.

**Acceptance.** A board with messages, events, tokens, passkeys, versions, staging, generations and backups transfers SQLite to Postgres, Postgres to MySQL, and MySQL back to SQLite, and after each transfer `seq.next`, `published_through`, every message id, every token hash and the byte hash of every blob column are identical, a new message gets the next `seq` without collision, the first generation after the transfer passes its self-test, the source refuses to start with `store_transferred`, and a transfer killed during step 7 leaves a target that refuses to start with `store_transfer_incomplete`. This is the test that makes R4b and R15 real.

**Must stay green.** All three engine suites.

### Which steps pay for themselves on SQLite alone

**Steps 0 through 4, all of them.** The `user_version` ladders become a real migration ledger with a concurrency-safe lock. The 41 hand-rolled prefix matches become one tested helper. The silent-semantic-change sites get tests. The store descriptor makes rehearsal and restore stop talking about filenames, which is the change that makes `app-backup.ts`'s "path to a database file" assumption stop leaking into five other modules, and the store identity replaces an `fs.exists` with a check that would also have caught a mis-mounted volume. That is about a week of work and it leaves the project strictly better off with no new engine and no new dependency.

Steps 5 through 8 buy the remote engines and the ability to move between them, and nothing else. They are worth doing because the owner wants a deployment to pick its backend; they are not worth doing for their effect on the SQLite path, which is neutral by construction.

---

## 14. What weakens, honestly

### 14.1 Rehearsal on a remote engine: slower, and it catches less in three ways

On SQLite, `VACUUM INTO` is a file-sized copy at local disk speed, and `SPEC.md` §7.1's 30-second rehearsal deadline is generous at personal-board scale. On Postgres and MySQL the copy is a logical dump and load, which is slower per byte and grows with row count and index count, not just bytes.

`SPEC.md` §7.7 step 2 requires rehearsal to complete *before* the freeze, so a slow copy does not extend the window in which writes are queued; it extends the total time an edit takes. Past some data volume the owner must either raise `REHEARSAL_COPY_BUDGET` or accept that edits are slow. There is no third option that preserves R6, and R6 is the guarantee that catches "a migration that drops or renames a column" — the specific failure `SPEC.md` §7.4 exists to catch.

`CREATE DATABASE … TEMPLATE` is the fast alternative and it is rejected for a reason beyond connection count: template copy needs zero connections to the source, and the cutover only reaches that state at step 8, after the freeze. Using it would move rehearsal inside the freeze budget, which is exactly what `SPEC.md` §7.1's "slow work happens before the freeze" forbids.

Three things a dump-and-load rehearsal stops catching, or newly risks, that `VACUUM INTO` did not:

- **A logical reload normalises the store.** `VACUUM INTO` reproduces the physical store; a dump and load rebuilds every index and re-applies every constraint. On the same server version that should never reject a row the live store holds, but when it does (a `sql_mode` difference on MySQL is the realistic case) the failure surfaces as `clone_load_failed`, a distinct code, so an agent is not sent to look at its edit or at the store's size.
- **The clone is not isolated from production.** On SQLite the rehearsal copy is a file on the volume under an explicit byte budget. On a remote engine it is a database on the same server, sharing the disk, the connection cap and the buffer pool with the live store. A rehearsal of a migration that rewrites a large table can degrade or fill the live store. The `scratch_limit` refusal and the success-path drop (section 5.4) bound the count; nothing bounds the size, and section 16 item 1 says to measure before trusting the default budget.
- **DDL against the live store can stall reads** for up to the `lock_timeout` from section 9.7, which the rehearsal clone cannot reproduce because it has no concurrent readers. `SPEC.md` §7.7 step 4's "reads keep flowing" is weakened by that one second on both remote engines, and the compensation is the short timeout plus the step-8 restore.

### 14.2 Capacity is unknown, and headroom cannot be defended

Section 10.6 covers the mechanism. The honest statement of the loss: on a remote engine, `/_boot/status` can no longer tell the human "your store is at 72% of the volume". It can tell them each store is 4.2 GB, and nothing about the headroom. A store that fills up surfaces as a write failure, not as a warning, and because both stores are remote that write failure can be a boot-store write, which is `/_boot/*` failing. The 5% headroom refusal still protects the volume, where snapshots, dumps and caches land, but the property that mattered most on SQLite — a delete always has room to record itself — does not survive for rows that live on the server. What survives is that comms' own rows cannot be the cause without warning: the event and version byte caps from section 10.6 are absolute, measured, and shown in status.

### 14.3 `/_boot/*` depends on a remote engine

`SPEC.md` §7.1 invariant 1 is "`/_boot/*` always answers", and it is the first invariant for a reason: it is the way back in when everything else is broken. With the boot store on Postgres, a network partition between the container and the database takes out authentication, the event log, the edit lock, the generation list and `/_boot/fs` at once. On SQLite, none of those depend on anything but the local disk.

`SPEC.md` §9 already concedes this as "the durability tradeoff a deployment chooses on purpose", and R11 restates it. It is the single largest behavioural cost of the whole track, and it applies identically to Postgres and MySQL. Say it plainly to anyone choosing either: you are trading "always answers" for "provider-managed durability", and comms cannot give you both. It is also the strongest argument for keeping SQLite as the default rather than merely as one of three.

One mitigation ships with step 5, because remote deployments are supported rather than hypothetical. `GET /_boot` is a hardcoded plain-text help page that touches no store (`SPEC.md` §7.1 invariant 1), so it keeps answering through a database outage. The 503 body for the rest of `/_boot/*` says "the boot store is unreachable" and names the host it could not reach, rather than returning a generic failure that sends the human to debug their last edit.

### 14.4 What is weaker on MySQL than on Postgres, and how each is compensated

MySQL ships, so this list is not an argument against it. It is the set of places where a MySQL deployment gets a weaker version of a guarantee the reference implementation provides, together with the mechanism that makes the weaker version acceptable. Each compensation has a test in section 12.3; a compensation without a green test is not a compensation.

**1. No transactional DDL. This is the serious one.**

`Migrator` runs its whole pending batch inside `sql.withTransaction` (`Migrator.ts:308`), and `packages/server/src/kernel/migrations.ts:45-49` wraps that in an outer transaction that holds the epoch gate at `:47`. On SQLite and Postgres, a migration that fails halfway rolls the entire batch back, which is what `packages/server/src/migrations/README.md:15` promises: "Failure rolls back the entire pending batch."

MySQL implicitly commits on every DDL statement. Four consequences, in descending order of nastiness:

- The ledger insert happens *before* the migration effects run (`Migrator.ts:263-273` inserts the rows, `:276` runs them), so the first DDL statement commits the ledger claiming every migration in the batch applied. A failure at migration 3 of 5 leaves the ledger saying 5 and the schema at 3. Nothing will ever re-run 4 and 5.
- The outer transaction's epoch gate commits with it, which releases the fence row lock. A second writer can then legally acquire the fence *while the candidate is still running migrations*, and nothing re-checks: the cutover's 5-second deadline at `cutover.ts:230` fires, its failure path installs a fresh epoch (`cutover.ts:68`), and boot restores the pre-flip backup on a target the abandoned candidate may still be issuing `ALTER TABLE` against. On SQLite and Postgres the candidate's transaction holds the row and boot's `UPDATE` waits.
- `Migrator`'s ledger lock is Postgres-only (`Migrator.ts:224-227`), so MySQL's only concurrency defence is the unique violation on the batch insert, which stops being a defence once that insert has committed at the first DDL.
- A failed migration leaves the live store partially migrated rather than untouched.

**Compensation, in four layers.** First and most important, R6: rehearsal runs the real migration against a real copy in a real candidate process before the live store is touched (`SPEC.md` §7.4, §7.7 step 2). A migration that fails deterministically never reaches the live store on any engine, MySQL included. Second, `SPEC.md` §7.7 step 5 takes a backup after the freeze and the drain and before `go`, and step 8 restores it when health fails. On SQLite and Postgres that restore is belt and braces; on MySQL it is load-bearing, and it is the only thing that puts a half-migrated store back. Third, on MySQL the migration runner re-asserts the epoch gate as its own statement before each migration in the batch: `migrations.ts` maps the loader so every loaded migration effect is prefixed with `writerGate`, and a fenced-out candidate therefore stops at the next migration boundary instead of running to the end. That makes the gate per-migration rather than per-batch on MySQL, which is the honest weakening. Fourth, the restore path gets the same rehearsal the cutover has (section 10.3), because it is the path on which a half-applied batch is most likely to be reached: the restored store is older than the running source, the forward migrations run against rows no rehearsal saw, and without the rehearsal the human's restore fails identically on every retry.

The app's migration README also gains a MySQL paragraph telling agents that a batch is not atomic there, so a migration that must be all-or-nothing should be written as one statement.

**What remains genuinely weaker:** a migration that fails *non-deterministically* — passes rehearsal against the copy, fails against the live store — leaves MySQL needing the restore where Postgres would simply roll back. The restore costs the freeze window and a generation restart. It loses no acknowledged write, because the backup was taken after the drain, which is precisely why step 5 exists.

**2. No partial unique index.**

`packages/boot/src/source-schema.ts:70` enforces "at most one batch publishes at a time" in the database. **Compensation:** the stored generated column plus a unique index on it (section 7.2), which is exactly equivalent because MySQL's unique indexes ignore NULLs. Tested by section 12.3's concurrent-publish test. Nothing weakens; the substitute is a different spelling of the same constraint.

**3. No `RETURNING`, and an affected-row count that lies.**

Five statements, listed in section 6.8, four of which are on the durability hot path including the writer-epoch fence itself. **Compensation:** a locking select for the two fence statements and a select after the write for the rest, in the same transaction, reading under the row lock the statement took; never a branch on affected rows, which MySQL reports as rows *changed* and which is zero for the fence's deliberate no-op. That is genuinely equivalent for the four `SELECT`/`UPDATE`/`INSERT` cases. The `DELETE` case in `packages/boot/src/event-retention.ts:36-38` is not, and it is compensated differently: select the candidate `seq` values with the age predicate first, then delete by that explicit list.

**What remains genuinely weaker:** two round trips instead of one on every kernel write, since the fence at `packages/server/src/kernel/database.ts:7-11` runs on every mutation. Against a remote MySQL that is one extra network hop inside the write lock, which section 9.4 already budgets. It is a latency cost, not a correctness cost.

**4. No ownership protection for boot's tables in the app database.**

On Postgres, boot owns `kernel_writer`, `mutation_batches`, `outbox` and `store_identity` inside `comms_app`, and only the owner may drop them, so an app-side migration cannot remove the tables boot recovers from (section 3.2). MySQL has no per-table ownership, and `comms_app` needs `DROP` on `comms_app.*` to manage its own schema. **Compensation:** the startup shape probes that already exist — `packages/server/src/kernel/database.ts:27-31` selects from `outbox` and `mutation_batches` at child start — fail the candidate before it serves, so a generation that drops a recovery table fails health and never goes live; step 1 adds `store_identity` to that probe. Boot then recreates the tables during recovery at `packages/boot/src/app-recovery.ts:39-41` exactly as it does on a fresh store, except `store_identity`, whose absence is `app_store_missing` by design (section 10.3) and needs a human to confirm. **What remains genuinely weaker:** the failure is caught at candidate health rather than refused at DDL time, so an agent sees a failed cutover rather than a failed migration statement. The board keeps serving from the old generation either way.

**5. Case- and accent-insensitive collation by default, and no per-transaction isolation control.**

Covered in sections 3.3 and 9.2. **Compensation:** `utf8mb4_0900_as_cs` set explicitly on both databases by the grant script, and a startup assertion that reads `information_schema.COLUMNS.COLLATION_NAME` over every text key column (not `SCHEMATA`, which reports only the database default that a column created with its own collation, or before the default changed, does not inherit) and refuses `store_collation_unsupported`. That assertion is not optional: a server configured with the default collation would let two token hashes differing only in case collide on a `UNIQUE` index, which is a security-relevant data-loss bug rather than a compatibility annoyance. The isolation level cannot be set per transaction from inside `withTransaction`, so the read snapshot rests on the server's `transaction_isolation` default; the same startup pass asserts it is `REPEATABLE-READ` and refuses `store_isolation_unsupported` otherwise.

**6. Search drops short terms and stopwords.**

Covered in sections 8.3 and 8.4. **Compensation:** every surviving term is `+`-prefixed so the AND contract holds for everything the index contains, terms the index cannot contain are removed by comms before the query so they widen the page rather than empty it, and both behaviours are documented in the public route description. A dropped term returns a superset, never a reversed AND and never an error.

**7. `sql.updateValues` is unavailable.**

`MysqlClient`'s compiler stubs `onCustom` and `onRecordUpdate` to empty (`MysqlClient.ts:472-477`), so the multi-row update helper produces nothing. It is also unsupported on SQLite, per the note on `Statement.ts:479-488`. **Compensation:** none needed. comms does not use it today and must not start; the portable form is a loop of single-row updates inside one transaction, which is what the codebase already does.

**8. Stored routines and events are not backed up.**

`mysqldump` runs without `--routines` and `--events` because comms defines neither and dumping another definer's routine needs a global privilege the boundary refuses (section 5.2). **Compensation:** none; an agent-authored migration that creates a stored procedure, function or event on MySQL creates something a backup, a rehearsal clone and a transfer will not carry. The migration README says so. This has no equivalent on the other engines only because `pg_dump` carries functions without a special privilege; it is a real MySQL-only gap.

**The honest summary.** Six of the eight are substitutes that preserve the guarantee, item 1 is the one that genuinely relies on a recovery path rather than on prevention, and item 8 is a gap with no compensation beyond a sentence in the README. An editing agent on MySQL inherits a third dialect's worth of reasoning and one rule it does not need elsewhere: on MySQL, a migration batch is not atomic, so write migrations that can be re-run and keep each one small.

### 14.5 The null hypothesis: what staying on SQLite forever actually loses

Stated honestly, because it is a real option and the cheapest one. Railway volumes attach to one service and force a single replica; EBS attaches to one instance; Docker on a VPS is a bind mount. All three satisfy `SPEC.md` §9's deployment contract exactly as written.

**What you lose by staying on SQLite:**

- **Nothing that `SPEC.md` promises.** Every guarantee in §7 is implemented and tested today.
- **Provider-managed point-in-time recovery.** You keep the hourly and pre-flip backups and the weekly drill, which is more verification than most managed setups actually run, but the backups live on the same volume as the data, so a volume loss loses both. The existing answer is the offsite extension mentioned in §7.5 and §9: a few dozen lines of cron extension against object storage, and strictly cheaper than this entire track.
- **Multi-container hosting and horizontal scale.** Irrelevant for a one-human board, and section 9.6 says this design does not deliver it anyway.
- **Read concurrency.** `BEGIN IMMEDIATE` serializes every transaction, reads included (`SqliteClient.ts:7-9`, `:238`). On a personal board that is free. It is the thing that would bite first if this ever had many readers, and it is the one thing the remote engines genuinely buy on the read side, because section 9.2's snapshot holds no lock.

**What you pay for the pluggable version:** roughly 3,700 added lines and 860 removed, a dialect layer every editing agent must respect, a store whose free space the bootloader cannot see and whose headroom it cannot defend, a rehearsal whose cost grows with data volume and shares a server with production, two required container CI jobs, two extra client binaries in the image, a `/_boot/*` with a network dependency, a restore that changes which database is the board and a journal to remember it, a transfer tool with its own markers, and — on MySQL only — a migration batch that is not atomic.

**What the owner is buying, stated plainly.** Not durability: the SQLite path with an offsite backup extension is durable enough for a one-human board, and section 14.3 shows the remote path actually gives up an availability guarantee to get durability. What it buys is that the backend is a deployment choice rather than a property of the software, so a board can live wherever the person running it already keeps databases, and can move later without an export-and-retype, on the condition section 15.6 states. That is a legitimate thing to want, it is what R4 and R4b say, and it is the reason all three engines ship rather than one.

**The sequencing recommendation is unchanged even though the scope grew.** Do steps 0 through 4 first and land them on SQLite alone; they are net-positive with no new engine and no new dependency, and they are what makes steps 5 and 6 additive rather than invasive. Then Postgres, where almost nothing weakens: `RETURNING`, partial indexes, transactional DDL and `tsvector` all exist, and pglite means the whole dialect suite runs in CI without Docker. Then MySQL, where eight things weaken and section 14.4 says what each costs and what compensates it. Do not start MySQL before Postgres is green, because Postgres is what proves the dialect layer is real and MySQL is what proves it is complete.

---

## 15. Swapping an existing deployment

R4b says a board can move between engines without losing anything. This section says what that actually involves, because "swap the descriptors" is true and insufficient.

### 15.1 What moves

Both stores move, together. R1 forbids a mixed deployment, so a transfer that completes on one store and fails on the other must be refused rather than left half-done.

| Store | What is in it | Why it cannot be regenerated |
| --- | --- | --- |
| Boot | The 25 boot-store tables the boot ladder creates at the working tree: `passkeys`, `sessions`, `auth_challenges`, `tokens`, `enrollments`, `refresh_receipts`, `refresh_idempotency`, `mint_receipts`, `seq`, `events`, `event_batches`, `versions`, `source_batches`, `source_changes`, `staging`, `edit_lock`, `generations`, `child_attempts`, `backups`, `settings`, `cutover`, `db_restore_requests`, `topic_moves`, `topic_page_moves`, `public_paths`, and the boot-migrations ledger, plus whatever a later boot migration adds. The authoritative list is the ladder, and the tool enumerates it from the ledger rather than from a hand-written inventory | Losing `passkeys` locks the human out permanently. Losing `versions` loses every undo. Losing `events` loses the log `SPEC.md` §6.1 calls the one queryable record. Losing `refresh_receipts`, `refresh_idempotency` or `mint_receipts` turns an agent's in-flight replay into token reuse (section 15.5). |
| App | `topics`, `messages`, `reads`, `kv`, `agents`, `reactions`, `idempotency` and the three `*_idempotency` tables, `webhook_subscriptions`, the FTS index, the app-migrations ledger, every agent-added table, plus the four boot-owned tables from section 3.5 | The board. |

Two rows carry the whole sequence contract and deserve naming individually. `seq.next` and `seq.published_through` in the boot store are the allocator and the publication fence from `SPEC.md` §6.3, and that section says sequence values are **never reused, including across restores**. A transfer that resets `seq.next` to 1, or that loads `events` without loading `seq`, hands out sequence numbers that already name other messages. Every cursor an agent holds becomes wrong, silently. `seq` transfers first and is verified before anything else is written.

The event log and the allocator move together, in the same run, or the transfer is refused. They are in the same store, so this is easy to honour and easy to forget.

The two rows name what is individually catastrophic to lose, not the full set; the transfer copies every table the ledgers know about, and step 7 says so. Two groups deserve naming because their loss is silent rather than loud: the idempotency tables, whose loss makes a retried key mint a second message instead of returning the first; and the in-flight state tables (`cutover`, `db_restore_requests`, `topic_moves`, `topic_page_moves`, `child_attempts`), whose loss makes a transfer taken mid-operation unrecoverable, which is why step 1 refuses to run while any of them has a pending row.

### 15.2 Why engine-native tools cannot do this

`pg_dump` cannot read a SQLite file, and `sqlite3 .dump` produces SQL that Postgres rejects. There is no pair of vendor tools that moves a schema between two of comms' three engines, and writing a translation layer over their output would mean parsing dialect SQL, which is exactly the thing this design exists to avoid.

So the transfer is comms' own: it reads every table through one `SqlClient` and writes it through another. That reuses the per-dialect DDL from section 7.2, the type mapping (integer booleans stay integers, JSON text becomes `jsonb` or `JSON`, `BLOB` becomes `bytea` or `LONGBLOB`), and the `Schema` decoders that already exist for every row. Decoding validates *shape*: a row that will not decode on the way out is a row that would have been silently mangled by a textual dump. It does not validate *content*: a driver that hands back a `Uint8Array` of the wrong bytes decodes perfectly, which is why step 9 hashes bytes rather than trusting the decoders for binary columns.

The cost is that it is row-by-row and single-threaded. At personal-board scale that is seconds to minutes. It is not the right tool at ten million messages, and nobody should pretend otherwise.

### 15.3 The procedure

Run as an offline command in the image, never over HTTP. This is a human, one-way, whole-system operation, and `SPEC.md` §7.5 already establishes that database-level operations are human decisions.

```
bun boot.js store-transfer \
  --from-app file:/data/comms.db      --from-boot file:/data/boot.db \
  --to-app   postgres://…/comms_app   --to-boot   postgres://…/comms_boot
```

`--check` runs steps 1 through 5 against a scratch target and reports, without writing a row of data, so an operator learns about a non-portable migration before scheduling downtime.

1. **Refuse to run while anything is alive.** No live child, no candidate, no pending cutover, no pending restore, no pending source publication, and **no outstanding sequence reservation**: `seq.pending_id IS NOT NULL` (`events.ts:203`) is added to `recoveryIntents` (`packages/boot/src/recovery-intents.ts:5-11`), which today reads only `cutover`, `db_restore_requests`, the two move tables and `source_batches`. The command reads the same intents that `packages/boot/src/database-restore.ts:212-214` refuses on, so the source resolves its own reservation before the transfer starts and the target is a faithful copy from step 6 onwards.
2. **Prove closure.** Positive closure evidence from the child keeper, the same requirement R8 imposes on restore, and for the same reason: an orphaned child still connected to the source store will keep committing writes that the transfer has already read past, and those writes are acknowledged and then gone. `supervisor.assertClosure` is the existing check and it applies unchanged.
3. **Quiesce and back up the source.** Take a normal backup of both stores through `DbOps.backup` before reading anything. If the transfer fails at any point, the source is untouched and this backup is belt and braces; if the operator has already switched their environment variables, it is the way back.
4. **Create the target schema by running migrations.** Not by copying DDL. The target gets its schema from the same migration ladder every fresh deployment runs, with the target dialect's branches. That is what guarantees the target's schema is one this image understands, and it is where a non-portable agent-authored migration fails, before any data is written (section 15.6).
5. **Compare the migration ledgers, and refuse a mismatch.** Never copy them: step 4 has already written the target's ledgers, `migration_id` is their primary key in every dialect variant (`Migrator.ts:124`, `:133`, `:140`, `:147`), and inserting the source's rows on top raises a unique violation that `Migrator` would report as `Locked`, "Migrations already running". The source's `boot_migrations` and `migrations` rows are compared against what step 4 applied. They must agree exactly. A source at a higher migration id than the image supports is the same `BootSchemaTooNew` refusal section 7.4 describes, and a source at a lower id means the operator should upgrade the image before transferring, not during.
6. **Mark the target in progress, then copy `seq` first and verify it.** The first data write is a `settings` row in the target boot store, `transfer_state = in_progress`, carrying the source descriptors (without credentials) and the start time. Then `seq.next` and `seq.published_through` are read, written, and read back before any other table is touched. Boot refuses to start on a boot store whose `transfer_state` is `in_progress` with `store_transfer_incomplete`, naming the transfer, so a target abandoned at any later step cannot be mistaken for a finished one (section 15.4).
7. **Copy every remaining table, boot store first, in dependency order.** Boot first because `events` and `versions` are the records that make a failed transfer diagnosable. Two foreign keys are declared, `source_changes.batch` and `versions.batch` referencing `source_batches(id)` (`packages/boot/src/source-schema.ts:71-72`); SQLite never enforces them because comms does not set `PRAGMA foreign_keys`, while Postgres and MySQL always do, so `source_batches` is copied before those two and the rest of the order is about diagnosis rather than constraint satisfaction. Blob columns are read and written as bytes on every engine, never through a text path.
8. **Clear process-lifetime evidence.** `child_attempts` rows carry keeper receipt paths that only mean something on the source box; step 2 proved their processes dead, so the transfer closes them (`closed=1`) and resets `boot_id`, and asserts that `cutover`, `db_restore_requests`, `topic_moves` and `topic_page_moves` carry no pending row (step 1 already guaranteed it; this is the check on the copy). A `child_attempts` row left `opened=1 AND closed=0` would make `ChildAttempts.recover` fail `child_closure_unproven` (`packages/boot/src/child-attempts.ts:58`) on the first start against the target.
9. **Fix the identity sequences.** This is the trap. Every autoincrement key copied as a literal value leaves the target's generator at zero, so the next insert collides with row 1. Per engine, and the three cannot share a shape:
    - Postgres: `SELECT setval(pg_get_serial_sequence('generations','n'), MAX(n), true) FROM generations WHERE n IS NOT NULL`, skipped entirely when the table is empty. `pg_get_serial_sequence` resolves identity columns as well as serials, so it is right for section 7.2's `GENERATED BY DEFAULT AS IDENTITY`; two-argument or `true` `setval` makes the next value `MAX(n)+1`. Do not `COALESCE` the maximum to 0: `setval` rejects 0 as out of bounds, and `setval` is strict, so a bare `MAX(n)` of `NULL` would silently do nothing, which is the right outcome by accident and the reason the empty case is skipped explicitly instead.
    - MySQL: `ALTER TABLE generations AUTO_INCREMENT = <max+1>`, with the value read back and interpolated by the transfer, because `ALTER TABLE` accepts no subquery there.
    - SQLite: nothing. SQLite maintains `sqlite_sequence` itself for an `AUTOINCREMENT` table and raises it on any insert with a larger explicit rowid, so the row copy already leaves it right; the transfer asserts it rather than writing it.

    It applies to `generations.n` (`packages/boot/src/boot-schema.ts:42`) and `versions.id` (`packages/boot/src/source-schema.ts:72`), the only two `AUTOINCREMENT` columns in either store, and to any table a future migration gives an identity column.
10. **Verify, bytes first.** Row counts per table; `MAX(seq)` in `events`, `messages` and `outbox`; `seq.next`, `seq.published_through`; and a content hash, computed with the same function on both sides over the raw bytes, over every column the board cannot regenerate: `passkeys(id, public_key, counter)`, `versions(id, sha, content, previous_content)`, `staging(lock_id, path, sha, content)`, `source_changes(batch, path, before, desired)`, `tokens(hash)`, `refresh_receipts` in full, and `messages(id, seq, body, tags, meta)`. Binary round-tripping across three drivers is precisely where a silent mangling happens (a `bytea` returned as a hex-prefixed string, a `LONGBLOB` coerced through UTF-8, a zero byte truncating a value), and a row count cannot see any of it. Any mismatch fails the transfer and leaves the target for diagnosis, still marked in progress, rather than dropping it.
11. **Complete the target and stamp the source, in that order.** In the same target transaction as the last verified count, `transfer_state` flips to `complete`. Then the source boot store gets `settings.transferred_to` (target engine, host and database names, timestamp) and the source app store's `store_identity.transferred_to` is set. Boot refuses to open either with `store_transferred`, naming where the board went. Leaving the source readable is deliberate — it is the way back — but reachable-by-default is not the same as reversible: reversal is running the transfer in the other direction, which clears the stamp.
12. **Install a fresh writer epoch in the target app store and reconcile.** `AppRecovery.prepare` against the target, exactly as boot does on any ordinary start, so the fence is fresh. Step 1 guaranteed there is no pending reservation to resolve. Never carry the source's epoch across. The target's `store_identity` row keeps the source's `store_id`, and the target boot store's `app_store_id` and `app_store_database` are written to match (R13).
13. **Switch the descriptors.** The operator sets `DATABASE_URL` and `BOOT_DATABASE_URL` and restarts the container. Nothing in comms rewrites the operator's environment; what comms did do is make the old defaults refuse to serve (step 11).
14. **Rehearse before serving.** The first generation after a transfer goes through the ordinary cutover, so the self-test runs against the transferred store before it takes traffic. That is not a special case; it is what `SPEC.md` §7.4 already does on every start, and it is the check that catches a transfer that copied rows but broke an index.

### 15.4 What can still go wrong

**A partially written target.** Steps 7 through 10 can fail with rows already in the target. The target is left in place, marked `in_progress`, and the source is untouched, so the recovery is "drop the target database and run it again". On SQLite the target is a file the operator deletes. The marker is what makes "drop it and run it again" a detectable requirement rather than a remembered one: every other startup check comms has (the ledger's max applied id, the shape probes, the initialisation marker, the writer fence) passes on a half-copied store, and a board serving with 40% of its messages missing would otherwise look like `db.restored` without the event. This is why step 3 exists and why nothing drops a failed target automatically.

**The source coming back.** R1's default is that unset URLs mean SQLite files under `/data`, and after a transfer those files are still a complete, internally consistent board frozen at the transfer instant. A deploy that rolls back a service configuration three weeks later would otherwise start boot on them, serve, and hand out sequence numbers three weeks behind the ones the Postgres board already used. The stamp from step 11 is the cheapest guard in the section: boot refuses with `store_transferred` and names the target.

**Collation surprises moving to MySQL.** Section 3.3's case-sensitivity requirement is enforced at transfer time too: the command refuses to write into a database whose collation is accent- or case-insensitive, because that is where two distinct token hashes would silently merge into one.

**Search indexes are rebuilt, not copied.** The FTS5 virtual table, the `tsvector` generated columns and the `FULLTEXT` indexes are all products of the target's migrations. They are populated by the row copy and, on SQLite, by the triggers from section 8.1. The verification in step 10 does not compare search results, because the three engines legitimately differ (section 8.4); it compares the underlying rows.

**Backups do not follow.** `backups` rows transfer, with their `engine`, but their artefacts stay on the volume in the source engine's format, and section 10.2's `backup_engine_mismatch` refuses them. The first restorable backup on the target is the first pre-flip or hourly one taken there; the operator output says so.

**Transferring back is the same operation.** SQLite to Postgres, Postgres to MySQL, MySQL to SQLite: one code path, two descriptors, no direction-specific logic. That symmetry is worth preserving even where a one-way shortcut would be faster, because a transfer people are afraid to reverse is a transfer people do not trust.

### 15.5 What this is not, and what the downtime costs

It is not replication, it is not live migration, and it is not zero-downtime. The board is down for the duration, which is the honest cost of a whole-system move and is consistent with `SPEC.md` §7.5's treatment of database-level operations as human decisions taken deliberately. Anyone who needs a zero-downtime engine change needs logical replication and a different design.

The downtime has one effect on credentials that the operator must know. Access tokens and sessions survive, enrollments survive, and a *short* transfer preserves the refresh replay window because `refresh_receipts`, `refresh_idempotency` and `mint_receipts` move with everything else. But `SPEC.md` §4.4's replay guarantee is a grace window of about a minute: an agent whose refresh response was lost at the instant the container stopped, and that retries after a twenty-minute transfer, presents a rotated predecessor outside the window, which is indistinguishable from theft and revokes the family by design, releasing its edit lock and dropping its staging. Quiesce agents before step 1, and expect that any agent mid-refresh at shutdown will need a fresh enrollment and a passkey tap.

### 15.6 The condition on R4b

The app's migration ladder is not shipped in the image: `SPEC.md` §7.4 makes `app/migrations/` agent-editable, and section 7.6's README paragraph is advice, not enforcement. A board that has run for six months has migrations written by agents who reached for `json_extract`, `INSERT OR REPLACE`, FTS5 virtual tables and two-argument `MAX` because those worked. Step 4 replays that ladder against the target and fails on the first one, with the source untouched. R4b is therefore conditional: **a board is transferable only if every agent-authored migration has a branch for the target dialect.**

Two things make the condition checkable rather than discovered on the day. `store-transfer --check` runs steps 1 through 5 against a scratch target of the destination engine and names the migration that fails, so it can be fixed with a forward migration before any downtime; and the rehearsal in `SPEC.md` §7.7 step 2 records, for every new migration, whether it took a dialect branch at all (a migration that never called `onDialectOrElse` and contains no helper fragment is portable only by luck), emitting a `migration.non_portable` warning without failing the edit. There is no in-process MySQL, so the second check is a heuristic; the first is the real one, and `SPEC.md` §12's "everything works after the swap" reads with this condition attached.

---

## 16. Open questions

Things the implementer must decide or measure. None of them block steps 0 through 4.

1. **Dump-and-load rehearsal time and size at realistic volume.** Nobody has measured `pg_dump | pg_restore` against a board with, say, 100,000 messages, nor how much of a shared server a clone occupies. The claim that it fits inside a 30-second budget is an estimate from personal-board scale, not a measurement. Measure it before setting `REHEARSAL_COPY_BUDGET`'s remote default and `SCRATCH_DATABASE_LIMIT`, and record the numbers in this document.
2. **Can pglite host the fence tests?** pglite is in-process and effectively single-connection. Section 12.1 assumes it cannot exercise two concurrent writers, which is why the container job exists. If pglite can be driven with two logical connections in one process, the Postgres container job shrinks to the role and ownership test, which is a meaningful CI saving. Check before building the Postgres container job.
3. **MySQL search tokenisation and stopwords.** `innodb_ft_min_token_size` is configurable, so a deployment could set it to 1 and match SQLite, and `innodb_ft_enable_stopword` can be turned off. Now that MySQL ships, this needs an actual decision rather than a preference: comms documents the divergence in the route description (section 8.4) and does **not** require the server setting, because `innodb_ft_min_token_size` needs a restart and an index rebuild to change and comms cannot make either happen on a managed server. Reopen this only if someone reports it as a real problem.
4. **`unaccent` availability on managed Postgres.** Section 8.2's diacritic folding needs a trusted extension. Confirm it is creatable by the database owner on the providers anyone actually uses before deciding whether degradation is the default or the exception.
5. **The read-snapshot argument.** Section 9.2 now rests on the writer invariant (one unpublished image per row) rather than on a lock. It is derived from `published-messages.ts:4-5`, `mutate()`'s ordering and the fence cache at `boot-channel.ts:164-178`, not observed. Section 12.3 item 2 is what turns it into a fact; until that test exists on both remote engines, treat the lock-free prelude as the argued choice rather than the proven one, and keep the `FOR SHARE` variant in mind as the fallback if the test finds a case the argument missed.
6. **Whether the freeze budget absorbs a remote deployment's mutation latency.** Section 9.4 gives the rule; nobody has measured the worst-case remote mutation. Measure `boot.reserve` plus `append` inside a mutation against a remote database on both engines (MySQL pays the extra fence round trip from section 14.4 item 3), and decide the remote default for `FREEZE_BUDGET` as a pass/fail against four concurrent mutations, not as a number to record.
7. **Transfer time and the acceptable downtime window.** Section 15 is row-by-row and single-threaded. Measure it at a realistic board size and write the number into `docs/deployment.md`, because "the board is down for the duration" is only an acceptable answer when the operator knows what the duration is, and section 15.5 says what a long duration costs agents mid-refresh.
8. **Whether MySQL's non-atomic migration batch needs a guard rail beyond the per-migration gate.** Section 14.4 item 1 relies on rehearsal, the pre-flip backup, the restore-path rehearsal and the per-migration gate. An alternative is refusing a multi-statement migration batch on MySQL outright, so every batch is one statement and partial application is impossible. That is more restrictive than the other two engines and would make some migrations awkward to write. Decide after the container job has been running long enough to see whether it ever actually bites.
9. **Role membership semantics across Postgres versions.** Section 3.2 relies on `GRANT comms_app TO comms_boot` conferring the app role's privileges through `INHERIT`, on a member being able to `CREATE DATABASE … OWNER comms_app` and `ALTER … OWNER TO comms_app`, and on the `pg_database_owner` ownership of `public` in clones (Postgres 15+). Postgres 16 changed how `INHERIT` and `SET` are recorded on the grant. The container test in section 12.3 item 7 pins the behaviour on the version the image targets; confirm the same grant script behaves on the managed providers' versions before calling the boundary reviewed.
10. **The `SET TRANSACTION` gap on MySQL.** Sections 5.2 and 9.2 work around MySQL's refusal to change transaction characteristics inside `withTransaction` with a reserved connection for the read-only route and a server-default assertion for isolation. If the vendored client ever gains a per-transaction opening statement (`SqlClient.ts:171` is where it would go), both workarounds collapse into one statement; watch the rc line for it.

---

## 17. Corrections to the investigation and to earlier revisions of this document

Every API name in `docs/pr-1/database-interoperability.md` was re-checked against the vendored source, and every claim in the previous revision of this document was checked against the two adversarial reviews and the working tree. These differ.

One of the investigation's conclusions is superseded by a later decision rather than by a fact: it recommended treating MySQL as designed-for and not shipped, and the owner has since required all three engines shipped and tested. Sections 12.3, 13 step 6, 14.4 and 15 are written to the newer requirement. The investigation's cost estimate for MySQL stands; what changed is that the cost is being paid on purpose.

| Investigation or earlier revision said | Correct |
| --- | --- |
| `Migrator.ts:222` takes `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` | `Migrator.ts:225`, and it is Postgres-only (`:226` is `orElse: () => Effect.void`) |
| `Migrator.ts:120-150` creates the ledger per dialect (an earlier revision's "correction") | `Migrator.ts:120-151`; the investigation had it right |
| `Statement.ts:1135` classifies `Uint8Array` (an earlier revision's "correction") | `Statement.ts:1136`; the investigation had it right |
| `Statement.ts:518-531` for the dialect helpers | `onDialect` at `Statement.ts:518-524`, `onDialectOrElse` at `:526-533` |
| `Statement.ts:995-1002` emits `RETURNING` | `Statement.ts:994-1005`, plus the insert path at `:938-946` |
| `Migrator.latestMigration` can be called to find the highest applied id | It is a local binding inside `make` and is not exported; comms runs the query itself (section 7.4) |
| `MysqlClient.layer` has error type `SqlError` | `Config.ConfigError \| SqlError` (`MysqlClient.ts:445-447`) |
| `PgMigrator`'s `pg_dump` environment can be copied as is | It reads `sql.config.*`, which is empty under a `url`-only configuration (section 5.5) |
| `cutover.ts`'s 30-second timeout covers the rehearsal copy | It bounds only the child's health; the copy has no budget today (section 5.3) |
| `SET TRANSACTION READ ONLY` inside `sql.withTransaction` on MySQL | Refused with `ER_CANT_CHANGE_TX_CHARACTERISTICS`; use `START TRANSACTION READ ONLY` on a reserved connection (section 5.2) |
| `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` plus `SELECT … FOR SHARE` is the read-isolation fix | `REPEATABLE READ` alone, with the fence taken from the process's own cache; the lock was unnecessary and harmful (section 9.2) |
| Two-argument `MAX` is a silent semantic change on Postgres and MySQL | It is a hard error on both (section 1.3); the site is `topic-move.ts:126`, not `read-marks.ts` |
| `to_regclass(?)` is the Postgres `tableExists` | It matches views, indexes and sequences and follows `search_path`; use `pg_class` with `relkind IN ('r','p')` (section 5.2) |
| `INSERT IGNORE` is the MySQL `DO NOTHING` | It suppresses every error, not only duplicate keys; use `ON DUPLICATE KEY UPDATE k=k` (section 6.5) |
| The MySQL `DELETE … RETURNING` replacement is "select the candidates, then delete by list" | The age predicate must move into the select (section 6.8) |
| `?schema=` on `postgres:` selects a schema | Unsupported; the pg URL parser ignores unknown parameters and the one-database shape has no `DbOps` (section 3.4) |
| `public_paths` is a boot-owned table in the app database | It is in the boot store (`boot-schema.ts:86`); the fourth boot-owned app table is `store_identity` (section 3.5) |
| Boot schema ladder ends at `user_version = 12`, then 13 | 14, at `boot-schema.ts:34` and `:88`; the app ladder is at 7, not 6 |
| `app-recovery.ts:22-23`, `:32`, `:92`, then `:34-35`, `:44`, `:104` | `:28-30`, `:44`, `:104` at the working tree |
| `app-backup.ts:20-26` clone, `:49-59` restore, `:42-46` ceiling | `:17-27`, `:35-46`; the ceiling query is deleted (item 21) |
| `public-pages.ts:64` then `:67` probes `sqlite_master` | Neither: the module reads the boot-owned `public_paths` (`:40`) and no longer probes |
| `events.ts:185-191` filter, `:123-156` reserve, then `:216-222`, `:153-187` | Filter at `:241-258` (rewritten with `GLOB`), reserve at `:176-210`, `finish` at `:76` |
| `auth.ts:321` / `:339` for the session `RETURNING` | `:338` at the working tree |
| `DbOps.capacity` on SQLite returns `statvfs` | There is no `statvfs` call; `readStorageVolume` (`storage-volume.ts:48-84`) shells `stat -f` on Linux and `df -kP` on darwin and `parseStorageVolume` (`:18-45`) parses |
| `backup-drill.ts:42-64` implements the drill | The file was deleted in commit `c6f2a14`; the drill is app-side now (section 10.4) |
| `agent-roster.ts:15-23` needs a `GROUP BY` fix | The file is deleted; the remaining `GROUP BY` sites are portable (section 7.2) |
| pg dumps shell out through `Command.make` | `ChildProcess.make` plus `ChildProcessSpawner`'s `spawner.string`, `PgMigrator.ts:48-64`. The `Command` form appears only in `MysqlMigrator.ts`'s commented-out block, which targets the v3 API |
| `pg/test/utils.ts:9` uses the two-parameter `Context.Service` form | It uses the one-parameter `{ make }` form; the two-parameter form is at `mysql2/test/utils.ts:21-24` |
| 33 `substr` sites, 352 `sql` template sites, 28 fixtures; then 49, 408, 39 | At the working tree: 46 (41 prefix matches), 433 and 47 |
| 15 `TEXT PRIMARY KEY` columns, 11 composite PKs | 22 and 13 at the working tree |
| 13 `${x ?? null} IS NULL` sites | 7 occurrences in 4 statements at the working tree; `events.ts` no longer uses the idiom |
| Six snapshot read sites | Seven (section 9.2); `extension-capabilities.ts:74` was missed |
| `mysqldump --single-transaction --routines` for backups and clones | `--no-tablespaces` is required from MySQL 8.0.21 or the dump needs the ungrantable global `PROCESS` privilege; `--routines` dropped (section 5.2) |
| Strip boolean operators, then `MATCH … IN BOOLEAN MODE` | Unprefixed terms are OR-combined in boolean mode; every term is `+`-prefixed and unindexable terms are removed first (section 8.3) |
| `websearch_to_tsquery` matches the contract | It interprets `or` and leading `-`; the query is built from the parsed parts with `plainto_tsquery`/`phraseto_tsquery` (section 8.2) |
| A dropped MySQL term yields fewer results, never wrong ones | It yields a superset once comms removes it; the AND contract holds only for indexed terms (section 8.4) |
| `setval(…, (SELECT MAX(n) …))` and a written `sqlite_sequence` row | Skip the empty table on Postgres; write nothing on SQLite (section 15.3 step 9) |
| The server re-exports boot's `store.ts` | Editable generations do not contain `@comms/boot`; the parser lives in a `packages/storage` workspace (section 4.3, from PR #2) |
| `APP_DATABASE` is renamed to `APP_STORE` | Both are emitted; the alias is load-bearing for retained pre-descriptor generations until a contract stamp exists (section 4.4, from PR #2) |
| `store_identity` and the boot marker are written "in the same transaction" | Two stores cannot share one; adoption is two-phase with a reserved UUID (section 10.3, from PR #3) |
| No upgrade path for backups taken before identity | `backups.legacy_store_id`, stamped once at adoption on the staging copy only (section 10.3, from PR #3) |

Things neither the investigation nor the earlier revision covered that this one adds: the Postgres `int8` codec (section 7.5), the MySQL JSON-null representation (section 6.3), the untyped-null parameter class (section 6.7a), the `GLOB` and planner-hint constructs the base work introduced (section 6.7b), the affected-rows trap (section 6.8), the ledger-creation order on Postgres (section 7.1), the allocator and edit-lock row locks (section 9.3), the durable store identity and journal (section 10.3), the transfer markers and source stamp (section 15.3), and the condition on R4b (section 15.6). Most of these break silently rather than loudly, which is why they were missed twice.
