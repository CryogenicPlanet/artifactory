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
CREATE DATABASE comms_dialect OWNER comms_app;
REVOKE CONNECT ON DATABASE comms_boot FROM PUBLIC;
REVOKE CONNECT ON DATABASE comms_app FROM PUBLIC;
GRANT CONNECT ON DATABASE comms_app TO comms_app,comms_boot;
"""
else:
 sql=f"""CREATE USER 'comms_boot'@'%' IDENTIFIED BY '{boot}';
CREATE USER 'comms_app'@'%' IDENTIFIED BY '{app}';
CREATE DATABASE comms_boot;
CREATE DATABASE comms_app CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
GRANT ALL ON comms_boot.* TO 'comms_boot'@'%';
CREATE DATABASE comms_dialect CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
GRANT ALL ON comms_dialect.* TO 'comms_app'@'%';
GRANT ALL ON comms_app.* TO 'comms_app'@'%';
GRANT SELECT ON performance_schema.session_account_connect_attrs TO 'comms_app'@'%';
"""
(root/'roles.sql').write_text(sql)
(root/'client.json').write_text(json.dumps(dict(engine=engine,host='127.0.0.1',port=0,database='comms_app',username='comms_app',password=app)))
(root/'dialect.json').write_text(json.dumps(dict(engine=engine,host='127.0.0.1',port=0,database='comms_dialect',username='comms_app',password=app)))
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
    "$image" --performance-schema-session-connect-attrs-size="$attributes" >/dev/null
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
  docker exec "$container" psql -U postgres -Atc 'SHOW server_version_num'
else
  docker exec -i "$container" mysql --defaults-extra-file=/run/secrets/admin.cnf < "$private/roles.sql" >/dev/null 2>"$private/provision-errors" || { echo "Database provisioning failed" >&2; exit 1; }
  docker exec "$container" mysql --defaults-extra-file=/run/secrets/admin.cnf -Nse 'SELECT VERSION()'
fi
published=$(docker port "$container" "$port/tcp")
python3 - "$private/client.json" "${published##*:}" <<'PY'
import json,pathlib,sys
for p in [pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[1]).with_name('dialect.json')]:
 d=json.loads(p.read_text()); d['port']=int(sys.argv[2]); p.write_text(json.dumps(d))
PY
if [ "$attributes" != 32 ]; then
  COMMS_REMOTE_DIALECT_CONFIG="$private/dialect.json" \
    node node_modules/vitest/vitest.mjs run packages/server/test/kernel/remote-dialect-semantics.test.ts --maxWorkers=1 --reporter=verbose
fi
COMMS_REMOTE_TEST_CONFIG="$private/client.json" COMMS_REMOTE_TEST_CONTAINER="$container" \
  COMMS_REMOTE_TEST_ENGINE="$engine" COMMS_REMOTE_TEST_ATTRIBUTES="$attributes" \
  node node_modules/vitest/vitest.mjs run packages/storage/test/remote-sessions.test.ts --maxWorkers=2 --reporter=verbose
