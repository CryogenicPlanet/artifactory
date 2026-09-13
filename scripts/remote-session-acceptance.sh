#!/usr/bin/env bash
# Disposable real-driver acceptance. Does not start a comms board or claim backend support.
set -euo pipefail
umask 077
engine=${1:?pg or mysql}
attributes=${2:-1024}
case "$engine" in
  pg) image='postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'; port=5432 ;;
  mysql) image='mysql:8.4.11@sha256:3466ba4a4828aa8d46fb7c3bc16b67b781c98413cf4ea0fac6feaa6e881faa26'; port=3306 ;;
  *) exit 2 ;;
esac
private=$(mktemp -d)
chmod 700 "$private"
container="comms-remote-${engine}-${RANDOM}-${RANDOM}"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$private"; }
trap cleanup EXIT HUP INT TERM
python3 - "$private" "$engine" <<'PY'
import json,pathlib,secrets,sys
root=pathlib.Path(sys.argv[1]); engine=sys.argv[2]
admin=secrets.token_hex(24); app=secrets.token_hex(24); boot=secrets.token_hex(24)
(root/'admin-password').write_text(admin)
(root/'admin.cnf').write_text('[client]\nuser=root\npassword='+admin+'\n')
if engine=='pg':
 sql=f"""CREATE ROLE comms_boot LOGIN PASSWORD '{boot}' NOSUPERUSER CREATEDB NOCREATEROLE;
CREATE ROLE comms_app LOGIN PASSWORD '{app}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT comms_app TO comms_boot;
CREATE DATABASE comms_boot OWNER comms_boot;
CREATE DATABASE comms_app OWNER comms_app;
CREATE DATABASE comms_schema_guard OWNER comms_app;
CREATE DATABASE comms_shared_store OWNER comms_app;
CREATE DATABASE comms_failed_lease OWNER comms_app;
CREATE DATABASE comms_read_cleanup OWNER comms_app;
CREATE DATABASE comms_collation_boot OWNER comms_app;
CREATE DATABASE comms_snapshot_boot OWNER comms_app;
CREATE DATABASE comms_snapshot_app OWNER comms_app;
CREATE DATABASE comms_schema_core OWNER comms_app;
CREATE DATABASE comms_schema_json_crash OWNER comms_app;
CREATE DATABASE comms_schema_unaccent OWNER comms_app;
CREATE DATABASE comms_schema_unaccent_fresh OWNER comms_app;
CREATE DATABASE comms_schema_unaccent_denied OWNER postgres;
REVOKE ALL ON DATABASE comms_schema_unaccent_denied FROM PUBLIC;
GRANT CONNECT ON DATABASE comms_schema_unaccent_denied TO comms_app;
CREATE DATABASE comms_concurrency_app OWNER comms_app;
CREATE DATABASE comms_concurrency_boot OWNER comms_app;
REVOKE CONNECT ON DATABASE comms_boot FROM PUBLIC;
REVOKE CONNECT ON DATABASE comms_app FROM PUBLIC;
GRANT CONNECT ON DATABASE comms_app TO comms_app,comms_boot;
"""
else:
 sql=f"""CREATE USER 'comms_boot'@'%' IDENTIFIED BY '{boot}';
CREATE USER 'comms_app'@'%' IDENTIFIED BY '{app}';
CREATE DATABASE comms_boot;
CREATE DATABASE comms_app CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
CREATE DATABASE comms_schema_guard CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE comms_schema_core CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE comms_schema_json_crash CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE comms_concurrency_app CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE comms_concurrency_boot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL ON comms_boot.* TO 'comms_boot'@'%';
CREATE DATABASE comms_shared_store CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
GRANT ALL ON comms_shared_store.* TO 'comms_app'@'%';
CREATE DATABASE comms_search_mysql CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL ON comms_search_mysql.* TO 'comms_app'@'%';
CREATE DATABASE comms_failed_lease CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL ON comms_failed_lease.* TO 'comms_app'@'%';
CREATE DATABASE comms_read_cleanup CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL ON comms_read_cleanup.* TO 'comms_app'@'%';
CREATE DATABASE comms_collation_boot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL ON comms_collation_boot.* TO 'comms_app'@'%';
CREATE DATABASE comms_snapshot_boot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE comms_snapshot_app CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL ON comms_snapshot_boot.* TO 'comms_app'@'%';
GRANT ALL ON comms_snapshot_app.* TO 'comms_app'@'%';
GRANT ALL ON comms_app.* TO 'comms_app'@'%';
GRANT ALL ON comms_schema_guard.* TO 'comms_app'@'%';
GRANT ALL ON comms_schema_core.* TO 'comms_app'@'%';
GRANT ALL ON comms_schema_json_crash.* TO 'comms_app'@'%';
GRANT ALL ON comms_concurrency_app.* TO 'comms_app'@'%';
GRANT ALL ON comms_concurrency_boot.* TO 'comms_app'@'%';
GRANT SELECT ON performance_schema.data_lock_waits TO 'comms_app'@'%';
GRANT SELECT ON performance_schema.threads TO 'comms_app'@'%';
GRANT SELECT ON performance_schema.session_account_connect_attrs TO 'comms_app'@'%';
"""
# Each parity case owns an initially empty app/boot pair; no shared test tables.
parity_databases=['comms_mutation_app','comms_mutation_boot','comms_read_marks','comms_protection']
parity_databases += [f'comms_outbox_{mode}_{side}' for mode in ['pending','incomplete','bounded'] for side in ['app','boot']]
for database in parity_databases:
 if engine=='pg':
  sql += f'CREATE DATABASE {database} OWNER comms_app;\n'
 else:
  sql += f"CREATE DATABASE {database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;\nGRANT ALL ON {database}.* TO 'comms_app'@'%';\n"
(root/'roles.sql').write_text(sql)
(root/'client.json').write_text(json.dumps(dict(engine=engine,host='127.0.0.1',port=0,database='comms_app',username='comms_app',password=app)))
(root/'dialect.json').write_text(json.dumps(dict(engine=engine,host='127.0.0.1',port=0,database='comms_shared_store',username='comms_app',password=app)))
for path in root.iterdir():path.chmod(0o600)
PY
if [ "$engine" = pg ]; then
  docker run --detach --name "$container" --publish "127.0.0.1::$port" \
    --mount "type=bind,src=$private,dst=/run/secrets,readonly" \
    --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password "$image" >/dev/null
  ready() { docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>"$private/readiness-errors"; }
else
  # The readiness probe uses TCP loopback; grant that exact host in addition to the default socket root account.
  docker run --detach --name "$container" --publish "127.0.0.1::$port" \
    --mount "type=bind,src=$private,dst=/run/secrets,readonly" \
    --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/admin-password --env MYSQL_ROOT_HOST=127.0.0.1 \
    "$image" --performance-schema-session-connect-attrs-size="$attributes" --log-bin-trust-function-creators=ON >/dev/null
  ready() { docker exec "$container" mysql --defaults-extra-file=/run/secrets/admin.cnf --host=127.0.0.1 -e 'SELECT 1' >/dev/null 2>"$private/readiness-errors"; }
fi
diagnose_readiness() {
  echo 'Database did not become ready' >&2
  docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$container" >&2 || true
  docker logs --tail 40 "$container" >"$private/server-errors" 2>&1 || true
  python3 - "$private" <<'PYDIAG'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1])
for name in ['readiness-errors','server-errors']:
 text=(root/name).read_text(errors='replace') if (root/name).exists() else ''
 # Every generated fixture password is exactly 48 lowercase hexadecimal characters.
 print(name+':\n'+re.sub(r'(?<![a-f0-9])[a-f0-9]{48}(?![a-f0-9])', '[REDACTED]', text), file=sys.stderr)
PYDIAG
}
for attempt in $(seq 1 120); do
  if ready; then break; fi
  if [ "$attempt" = 120 ] || [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    diagnose_readiness
    exit 1
  fi
  sleep 1
done
if [ "$engine" = pg ]; then
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < "$private/roles.sql" >/dev/null 2>"$private/provision-errors" || { echo "Database provisioning failed" >&2; exit 1; }
  docker exec "$container" psql -U postgres -d comms_schema_unaccent_denied -v ON_ERROR_STOP=1 -c 'GRANT USAGE,CREATE ON SCHEMA public TO comms_app' >/dev/null 2>"$private/provision-errors"
  docker exec "$container" psql -U postgres -Atc 'SHOW server_version_num'
else
  docker exec -i "$container" mysql --defaults-extra-file=/run/secrets/admin.cnf < "$private/roles.sql" >/dev/null 2>"$private/provision-errors" || { echo "Database provisioning failed" >&2; exit 1; }
  docker exec "$container" mysql --defaults-extra-file=/run/secrets/admin.cnf -Nse 'SELECT VERSION()'
fi
published=$(docker port "$container" "$port/tcp")
python3 - "$private/client.json" "${published##*:}" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); d=json.loads(p.read_text()); d['port']=int(sys.argv[2]); p.write_text(json.dumps(d))
for database,name in [('comms_collation_boot','collation'),('comms_concurrency_app','concurrency-app'),('comms_concurrency_boot','concurrency-boot'),('comms_schema_guard','guard'),('comms_schema_core','core'),('comms_schema_json_crash','json-crash'),('comms_shared_store','dialect'),('comms_search_mysql','mysql-search'),('comms_failed_lease','failed-lease'),('comms_read_cleanup','read-cleanup'),('comms_snapshot_boot','snapshot-boot'),('comms_snapshot_app','snapshot-app')]:
 d['database']=database; (p.parent/(name+'.json')).write_text(json.dumps(d))
for database,name in [('comms_mutation_app','mutation-app'),('comms_mutation_boot','mutation-boot'),('comms_read_marks','read-marks'),('comms_protection','protection')]:
 d['database']=database; (p.parent/(name+'.json')).write_text(json.dumps(d))
for mode in ['pending','incomplete','bounded']:
 for side in ['app','boot']:
  d['database']=f'comms_outbox_{mode}_{side}'
  (p.parent/f"{d['engine']}-outbox-{mode}-{side}.json").write_text(json.dumps(d))
if d['engine']=='pg':
 for suffix,name in [('', 'upgrade'),('_fresh','fresh'),('_denied','denied')]:
  d['database']='comms_schema_unaccent'+suffix; (p.parent/('unaccent-'+name+'.json')).write_text(json.dumps(d))
PY
# The intentionally truncated session-attribute case refuses before SQL admission.
if [ "$attributes" != 32 ]; then
  if [ "$engine" = pg ]; then
    COMMS_UNACCENT_FRESH_CONFIG="$private/unaccent-fresh.json" \
    COMMS_UNACCENT_UPGRADE_CONFIG="$private/unaccent-upgrade.json" \
    COMMS_UNACCENT_DENIED_CONFIG="$private/unaccent-denied.json" \
      node node_modules/vitest/vitest.mjs run packages/server/test/postgres-unaccent.test.ts --maxWorkers=1 --reporter=verbose
  fi
  COMMS_COLLATION_CONFIG="$private/collation.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/native-identifier-collation.test.ts --maxWorkers=1 --reporter=verbose
  if [ "$engine" = mysql ]; then
    COMMS_MYSQL_SEARCH_CONFIG="$private/mysql-search.json" \
      node node_modules/vitest/vitest.mjs run packages/server/test/ext/core/mysql-search.test.ts --maxWorkers=1 --reporter=verbose
  fi
  COMMS_CONCURRENCY_APP_CONFIG="$private/concurrency-app.json" COMMS_CONCURRENCY_BOOT_CONFIG="$private/concurrency-boot.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/native-concurrency.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_REMOTE_CORE_TEST_CONFIG="$private/core.json" \
  COMMS_REMOTE_CORE_JSON_CRASH_CONFIG="$private/json-crash.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/remote-core-schema.test.ts packages/server/test/remote-core-json-crash.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_MIGRATION_GUARD_CONFIG="$private/guard.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/migration-state-remote.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_TEST_ENGINE="$engine" COMMS_TEST_STORE_CONFIG="$private/dialect.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/remote-dialect-semantics.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_FAILED_LEASE_CONFIG="$private/failed-lease.json" \
    node node_modules/vitest/vitest.mjs run packages/storage/test/failed-lease.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_TEST_ENGINE="$engine" COMMS_READ_CLEANUP_CONFIG="$private/read-cleanup.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/remote-read-deadline.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_TEST_ENGINE="$engine" COMMS_MUTATION_APP_CONFIG="$private/mutation-app.json" \
  COMMS_MUTATION_BOOT_CONFIG="$private/mutation-boot.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/portable-mutation-durability.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_TEST_ENGINE="$engine" COMMS_OUTBOX_CONFIG_DIR="$private" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/portable-outbox.test.ts --maxWorkers=1 --reporter=verbose
  COMMS_PROTECTION_ENGINE="$engine" COMMS_PROTECTION_CONFIG="$private/protection.json" \
  COMMS_PROTECTION_DATABASE=comms_protection \
    node node_modules/vitest/vitest.mjs run packages/server/test/protection-lifecycle.test.ts --maxWorkers=1 --reporter=verbose -t "^$engine preserves protection"
  COMMS_READ_MARK_ENGINE="$engine" COMMS_READ_MARK_CONFIG="$private/read-marks.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/portable-read-marks.test.ts --maxWorkers=1 --reporter=verbose -t 'native read marks'
  COMMS_TEST_ENGINE="$engine" COMMS_SNAPSHOT_BOOT_CONFIG="$private/snapshot-boot.json" \
  COMMS_SNAPSHOT_APP_CONFIG="$private/snapshot-app.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/native-read-publication.test.ts --maxWorkers=1 --reporter=verbose
fi

COMMS_REMOTE_TEST_CONFIG="$private/client.json" COMMS_REMOTE_TEST_CONTAINER="$container" \
  COMMS_REMOTE_TEST_ENGINE="$engine" COMMS_REMOTE_TEST_ATTRIBUTES="$attributes" \
  node node_modules/vitest/vitest.mjs run packages/storage/test/remote-sessions.test.ts --maxWorkers=2 --reporter=verbose
