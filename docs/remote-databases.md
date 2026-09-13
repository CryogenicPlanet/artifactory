# Run with PostgreSQL or MySQL

Run one chirp instance against two existing databases on the same server: boot state and application state. Use a different login for each. Keep a persistent `DATA_DIR` for installed source, pages and generation artifacts.

This is the current remote-engine contract. It supersedes the remote lifecycle design in SPEC.md, tech.md and database.md: boot connects, initializes its tables, verifies board identity and coordinates its own writing sessions. Your database provider owns snapshots, restore and availability. SQLite keeps its file-copy recovery behavior.

## Create the databases once

Ask your database operator to create the databases and logins before starting chirp. Boot does not create roles, databases or temporary clone targets. A connection or privilege refusal needs operator repair; boot will not escalate privileges or create a replacement database.

The examples below use fresh names. Run them with an administrator connection, substitute independent passwords through your client's protected input, and keep credentials out of command arguments and logs. Existing names cause errors; inspect partial results before retrying. A managed provider may perform these steps through its console instead.

### PostgreSQL 17+

Run in `psql` as the operator. `boot_password` and `app_password` are psql variables populated privately before executing this SQL.

```sql
CREATE ROLE chirp_boot LOGIN PASSWORD :'boot_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE chirp_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE chirp_boot OWNER chirp_boot TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE chirp_app OWNER chirp_boot TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE chirp_boot FROM PUBLIC;
REVOKE ALL ON DATABASE chirp_app FROM PUBLIC;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE chirp_app TO chirp_app;

\connect chirp_boot
ALTER SCHEMA public OWNER TO chirp_boot;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect chirp_app
ALTER SCHEMA public OWNER TO chirp_boot;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO chirp_app;
```

Boot owns both databases, their public schemas and the protected application kernel tables. Initialization grants the app DML on `kernel_writer`, `mutation_batches` and `outbox`, and read access to `store_identity`. The app owns the product tables and trusted extensions it creates. Never grant the app membership in boot or ownership of its database/public schema: those powers would let editable code drop the container of protected tables. No runtime role needs `CREATEDB` or `CREATEROLE`.

### Oracle MySQL 8.4

Run as the operator, replacing the password placeholders privately. Restrict the `%` host match to your deployment where possible, consistently in every statement.

```sql
CREATE USER 'chirp_boot'@'%' IDENTIFIED BY '<independent boot password>';
CREATE USER 'chirp_app'@'%' IDENTIFIED BY '<independent app password>';
CREATE DATABASE chirpboot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE chirpapp CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL PRIVILEGES ON chirpboot.* TO 'chirp_boot'@'%';
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE, REFERENCES,
  CREATE VIEW, SHOW VIEW, TRIGGER ON chirpapp.* TO 'chirp_boot'@'%';
GRANT ALL PRIVILEGES ON chirpapp.* TO 'chirp_app'@'%';
```

The database names deliberately contain no `_` or `%`, which can act as wildcards in MySQL database grants. These grants contain no `GRANT OPTION`, global `CREATE USER`, `PROCESS`, `SUPER` or `XA_RECOVER_ADMIN`. MySQL lacks PostgreSQL table ownership protection: the app's DDL privileges also reach kernel tables in its database. The retained kernel and migration checks detect unsupported changes; this is not a database-enforced sandbox against adversarial editable code. Use InnoDB and `REPEATABLE-READ` isolation.

## Configure chirp

Set these through your deployment's protected environment configuration:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | App login and database, using `postgres://` or `mysql://` |
| `BOOT_DATABASE_URL` | Boot login and database on the same engine, host and port |
| `DATABASE_TLS` | `true` by default; `false` only for an intentionally private test connection |

Percent-encode credentials and database names. URL query parameters and fragments are unsupported. Verified TLS requires a trusted certificate and matching hostname; install a private CA in the image trust store when needed. Both URLs must be set together. Changing URLs does not migrate a board or authorize a foreign database.

## What reload and recovery promise

| Surface | Remote behavior |
| --- | --- |
| Writer admission | A pinned writing connection holds PostgreSQL's session advisory lock or MySQL's `GET_LOCK`. Another cooperating writer must wait for release or be refused. A lost session does not silently reconnect as a writer. |
| Rehearsal | Verifies the existing board identity and reads the expected columns of `kernel_writer`, `mutation_batches` and `outbox` without reading their data. It does not validate the candidate or product schema, clone data, or execute candidate migrations. |
| Cutover | Retires the previous app before the candidate runs migrations against the live database. A failed, unaccepted cutover requires operator repair; there is no automatic data rollback. |
| Backup | The provider takes and retains snapshots. Boot does not run dump tools or produce remote backup files. Existing catalogue records retain engine and board provenance; they are not proof of a usable provider snapshot. |
| Restore | Stop chirp, restore through the provider, then restart. Boot verifies board identity before serving and refuses a foreign store. It does not load artifacts or switch to a newly provisioned database. |

An advisory lock coordinates clients that follow this protocol. It does **not** prove every process or session using those credentials is dead, inspect prepared transactions, or fence a failed-over server. Arbitrary clients can bypass it. Multiple chirp containers, split-brain recovery and prepared-work cleanup are unsupported. Resolve those cases through the database operator; do not delete identity or recovery records to make startup pass.

The rehearsal response reports `schema_checked`, `schema_check_only: true` and `report_unavailable: true`. This check no longer catches data-dependent migration failures before touching live data. PostgreSQL transactions and the existing MySQL DDL intent checks still apply, but they do not restore a prior database after a completed migration. Take a provider snapshot before risky changes and accept the downtime needed for repair.

Identity proves the board, not snapshot freshness. An out-of-band provider restore does not rewind boot's sequence allocator or emit a `db.restored` event. Restoring only the app database can leave historical boot events describing data that the snapshot no longer contains. Restoring both stores may roll back credentials and event history too. The operator must choose a consistent recovery point; chirp does not coordinate provider snapshots or promise atomic recovery across them.
