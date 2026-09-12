# Provision a remote database

These are operator-run SQL scripts for a **new** comms installation on PostgreSQL 17+ or Oracle MySQL 8.4. They create two databases and two persistent logins: `comms_boot` and `comms_app`. Run them once with an administrator connection. comms never runs them at startup.

The names are fixed so the grants are easy to inspect. Review and change every occurrence together if your deployment needs different names. Existing names cause an error; these scripts neither replace accounts nor erase databases. Database/user creation is not atomic: after an error, inspect what was created before retrying.

## Prepare credentials

Keep administrator credentials in your database client's protected configuration (`PGPASSFILE`/service file for PostgreSQL; `--defaults-extra-file` for MySQL). Do not put passwords in command arguments, connection URLs on the command line, shell tracing, or verbose client output.

From the repository root, generate independent passwords and a MySQL input fragment in a private directory:

```sh
umask 077
private=$(mktemp -d)
python3 - "$private" <<'PY'
from pathlib import Path
import secrets, sys
root = Path(sys.argv[1])
boot, app = secrets.token_hex(32), secrets.token_hex(32)
(root / 'boot-password').write_text(boot)
(root / 'app-password').write_text(app)
(root / 'mysql-passwords.sql').write_text(
    "SET @boot_password='" + boot + "', @app_password='" + app + "';\n"
)
PY
```

Retain the two password files in your secret manager for the eventual `BOOT_DATABASE_URL` and `DATABASE_URL`. The scripts require distinct 64-character lowercase hexadecimal secrets and do not print them. Never run the examples with shell tracing enabled. Server-side statement/audit logging is controlled by your database operator; protect those logs as well.

## PostgreSQL

Use an administrator service entry named `comms-admin` that connects to a maintenance database on the target server:

```sh
COMMS_BOOT_PASSWORD="$(cat "$private/boot-password")" \
COMMS_APP_PASSWORD="$(cat "$private/app-password")" \
psql -X 'service=comms-admin' -f packages/boot/sql/postgres-roles.sql
```

Boot owns **both databases and their public schemas**. The app receives `CONNECT`, `TEMPORARY`, and `CREATE` on its database, plus `USAGE` and `CREATE` on its public schema. It owns the tables and trusted extensions it creates, including `unaccent` when available. It has no membership in boot and no superuser, database-creation, or role-creation privileges. Boot inherits the app role, allowing it to back up and recover app-owned objects. Boot initialization later grants app access to the specific protected tables it creates.

This corrects the older app-owned database/public-schema examples in [the database design](../../../docs/database.md#32-one-postgres-server-two-databases-two-roles). Database or schema ownership would let the app drop the container of boot's protected tables; table ownership alone does not grant that authority.

The server must have `max_prepared_transactions=0`; comms refuses a different setting. Configure this through the database operator, rather than changing a shared server automatically.

### Additional scratch-principal rights

The persistent-role script grants boot `CREATEDB`. The scratch provisioner additionally needs `CREATEROLE` to create an isolated login for a rehearsal or restore target:

```sh
psql -X 'service=comms-admin' -f packages/boot/sql/postgres-scratch-roles.sql
```

These PostgreSQL role attributes are server-wide, not restricted to a database-name prefix. Use a dedicated server or an operator-approved account policy. Neither attribute is granted to the persistent app login. Each scratch principal receives access to its own target; the persistent app must not gain access to every scratch database.

## MySQL

Use a protected administrator option file; `--defaults-extra-file` must be the first client option. Set its path in `MYSQL_ADMIN_CONFIG`, then run:

```sh
cat "$private/mysql-passwords.sql" packages/boot/sql/mysql-roles.sql |
  mysql --defaults-extra-file="$MYSQL_ADMIN_CONFIG" --batch
```

Do not add `--force` or `--verbose`: validation must stop the batch, and statements contain credentials. The fixed hexadecimal input avoids SQL-mode-dependent password escaping. Delete the temporary `mysql-passwords.sql` file when provisioning is complete.

The script uses `%` host accounts. Restrict network access to the comms host; if your deployment uses a narrower MySQL host match, change it consistently in every account and grant statement. The escaped database grant patterns require `partial_revokes=OFF` (the MySQL default); the script refuses other settings before creating accounts. The underscore escapes keep privileges from matching names such as `commsXapp`. Do not toggle this setting on a shared server merely to run the script; ask its operator for equivalent exact-database grants. Both databases use the case-sensitive binary `utf8mb4_0900_bin` collation. The app has broad DDL/DML only in its own database; MySQL cannot enforce PostgreSQL-style ownership protection for boot-created tables inside that database.

Both logins need the scoped session-attribute read grant for connection registration. Boot also needs `XA_RECOVER_ADMIN` to refuse recovery when prepared XA transactions exist. This is server-wide visibility; comms does not resolve unknown transactions. Neither login receives `PROCESS` or `SUPER`, and backups use `--no-tablespaces`.

Configure `performance_schema_session_connect_attrs_size` to at least 1024 before startup. On a binary-logged server, restoring agent-created triggers may also require the operator to enable `log_bin_trust_function_creators`; it is not permission to grant `SUPER` to the app.

### Additional scratch-principal rights

The persistent-role script alone does not grant clone/restore provisioning rights. The MySQL provisioner creates a separate short-lived login for each owned target and dump operation. Enable its explicit operator supplement only where that feature is being deployed:

```sh
mysql --defaults-extra-file="$MYSQL_ADMIN_CONFIG" --batch < packages/boot/sql/mysql-scratch-roles.sql
```

The supplement grants boot server-wide `CREATE USER`, source `SELECT` with `GRANT OPTION` plus metadata inspection rights, and delegable DDL/DML only on the escaped `comms_rehearsal_` and `comms_app_` target prefixes. `CREATE USER` cannot be limited to comms account names; use a dedicated server or an operator-approved role-management policy. The persistent app receives no scratch-pattern grants, `CREATE USER`, or `GRANT OPTION`. **MySQL applies `GRANT OPTION` at the database privilege level, not per individual privilege.** Granting it for source `SELECT` also permits boot to delegate every other source privilege it holds, including DDL/DML and metadata rights. Separate `GRANT` statements do not narrow that authority. This is an explicit additional trust in the boot account, not a restriction enforced by the database.

Source `SHOW VIEW`, `TRIGGER`, `EVENT`, and `EXECUTE` privileges let preflight inspect object kinds instead of mistaking inaccessible metadata for an empty result. Their presence is not a promise to copy arbitrary definers: the current provisioner refuses unsupported view/routine/trigger/event objects before publishing a target. It does not grant `SUPER`, `PROCESS`, `SET_ANY_DEFINER`, or `ALLOW_NONEXISTENT_DEFINER` to bypass that refusal. Keep the supplement aligned with the provisioner's accepted source-object policy and native acceptance tests.

See [deployment](../../../docs/deployment.md) for runtime configuration and [the database design](../../../docs/database.md) for recovery guarantees and engine differences. Provisioning accounts does not migrate an existing board's data.
