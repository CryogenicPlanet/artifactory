#!/usr/bin/env bash
# Native repair, shutdown and foreign-backup rejection with independent operator-provisioned pairs.
set -euo pipefail
umask 077
engine=${1:?pg or mysql}
board_image=${2:?built comms image}
case "$engine" in
  pg) database_image='postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0' ;;
  mysql) database_image='mysql:8.4.11@sha256:3466ba4a4828aa8d46fb7c3bc16b67b781c98413cf4ea0fac6feaa6e881faa26' ;;
  *) exit 2 ;;
esac
private=$(mktemp -d)
prefix="comms-repair-${engine}-${RANDOM}-${RANDOM}"
network="$prefix-network"
server="$prefix-server"
runner="$prefix-runner"
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    docker logs --tail 40 "$server" > "$private/server.log" 2>&1 || true
  fi
  # Never publish fixture passwords, passkey setup codes, or credential-bearing URLs.
  python3 - "$private" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1])
for name in ['readiness.log','provision.log','tests.log','server.log']:
    path=root/name
    if not path.exists(): continue
    text=path.read_text(errors='replace')
    text=re.sub(r'(?i)(?:postgres(?:ql)?|mysql)://[^\s]+','[DATABASE URL REDACTED]',text)
    text=re.sub(r'(?i)code\s+[a-f0-9-]{8,}','code [REDACTED]',text)
    text=re.sub(r'(?i)\b[a-f0-9]{64}\b','[SECRET REDACTED]',text)
    if text.strip(): print(name+':\n'+text)
PY
  # The entire test container and its DB server are disposable; no live-board resource is addressed.
  docker rm -f "$runner" "$server" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$private"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$private" "$engine" <<'PY'
import json,pathlib,re,secrets,sys
root=pathlib.Path(sys.argv[1]); engine=sys.argv[2]
(root/'configs').mkdir(mode=0o700)
admin=secrets.token_hex(32)
(root/'admin-password').write_text(admin)
(root/'admin.cnf').write_text('[client]\nuser=root\npassword='+admin+'\n')
operator=pathlib.Path('packages/boot/sql')
vendor='postgres' if engine=='pg' else 'mysql'
baseline=(operator/(vendor+'-roles.sql')).read_text()
scratch=(operator/(vendor+'-scratch-roles.sql')).read_text()
for scenario in ['missing','foreign','candidate','beforeallocation','afterselection','pending','password','migration','shutdownnormal','shutdownforce','foreigndonor','foreignrecipient']:
    boot,app=secrets.token_hex(32),secrets.token_hex(32)
    databases={kind:f'comms_repair_{scenario}_{kind}' for kind in ['boot','app']}
    users={kind:databases[kind] if engine=='pg' else f'cr_{scenario}_{kind[0]}' for kind in databases}
    def render(source):
        # Accounts and database names differ on MySQL to stay below its 32-character login limit.
        if engine=='mysql':
            for kind in databases:
                source=source.replace("'comms_"+kind+"'", "'"+users[kind]+"'")
                source=source.replace('`comms\\_'+kind+'`', '`'+databases[kind].replace('_','\\_')+'`')
        for kind in databases:
            source=re.sub(r'\bcomms_'+kind+r'\b',databases[kind],source)
        return source
    sql=render(baseline)+'\n'+render(scratch)
    if engine=='mysql':
        # The provisioner generates these same global target families; only the grantee changes.
        for pattern in ['`comms\\_rehearsal\\_%`','`comms\\_app\\_%`']:
            if sql.count(pattern)!=scratch.count(pattern): raise SystemExit('Generated target grant pattern changed')
        sql="SET @boot_password='"+boot+"', @app_password='"+app+"';\n"+sql
    (root/(scenario+'.sql')).write_text(sql)
    (root/(scenario+'.env')).write_text('COMMS_BOOT_PASSWORD='+boot+'\nCOMMS_APP_PASSWORD='+app+'\n')
    for kind,password in [('boot',boot),('app',app)]:
        (root/'configs'/f'{engine}-repair-{scenario}-{kind}.json').write_text(json.dumps(dict(
            engine=engine,host='database',port=5432 if engine=='pg' else 3306,
            database=databases[kind],username=users[kind],password=password)))
for path in root.rglob('*'):
    if path.is_file(): path.chmod(0o600)
PY
docker network create "$network" >/dev/null
if [ "$engine" = pg ]; then
  docker run --detach --name "$server" --network "$network" --network-alias database \
    --mount "type=bind,src=$private,dst=/run/secrets,readonly" \
    --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password "$database_image" >/dev/null
  ready() { docker exec "$server" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>"$private/readiness.log"; }
else
  docker run --detach --name "$server" --network "$network" --network-alias database \
    --mount "type=bind,src=$private,dst=/run/secrets,readonly" \
    --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/admin-password --env MYSQL_ROOT_HOST=127.0.0.1 \
    "$database_image" --performance-schema-session-connect-attrs-size=2048 >/dev/null
  ready() { docker exec "$server" mysql --defaults-extra-file=/run/secrets/admin.cnf --host=127.0.0.1 -e 'SELECT 1' >/dev/null 2>"$private/readiness.log"; }
fi
for attempt in $(seq 1 120); do
  if ready; then break; fi
  if [ "$attempt" = 120 ] || [ "$(docker inspect --format '{{.State.Running}}' "$server")" != true ]; then
    echo 'Repair fixture database did not become ready.' >&2; exit 1
  fi
  sleep 1
done
for scenario in missing foreign candidate beforeallocation afterselection pending password migration shutdownnormal shutdownforce foreigndonor foreignrecipient; do
  if [ "$engine" = pg ]; then
    docker exec --env-file "$private/$scenario.env" -i "$server" psql -X -U postgres -v ON_ERROR_STOP=1 \
      < "$private/$scenario.sql" >/dev/null 2>>"$private/provision.log"
  else
    docker exec -i "$server" mysql --defaults-extra-file=/run/secrets/admin.cnf --batch \
      < "$private/$scenario.sql" >/dev/null 2>>"$private/provision.log"
  fi
done
# Use the shipped native client tools with the checked-out source and exact host Node test runtime.
# The existing board job separately verifies the immutable entrypoint and OS user boundary.
node_binary=$(node -p 'process.execPath')
# Retained board roots contain large dependency caches. Each scenario gets a fresh
# disposable /tmp; do not delete individual roots or reinterpret their closure evidence.
run_scenario() {
  local test_file=$1 test_pattern=$2
  printf '\nNative scenario: %s\n' "$test_pattern" >> "$private/tests.log"
  docker run --rm --name "$runner" --init --user "$(id -u):$(id -g)" --network "$network" \
    --read-only --tmpfs /tmp:exec --cap-drop ALL --workdir /workspace \
    --mount "type=bind,src=$PWD,dst=/workspace" \
    --mount "type=bind,src=$private/configs,dst=/fixture,readonly" \
    --mount "type=bind,src=$node_binary,dst=/usr/local/bin/node,readonly" \
    --env NODE_ENV=test --env COMMS_ISOLATED=false \
    --env COMMS_REPAIR_ENGINE="$engine" --env COMMS_REPAIR_CONFIG_DIR=/fixture \
    --env COMMS_NATIVE_TEST_FILE="$test_file" --env COMMS_NATIVE_TEST_PATTERN="$test_pattern" \
    --entrypoint /bin/bash "$board_image" -c '
      set -euo pipefail
      test "$(node --version)" = v22.22.3
      test "$(bun --version)" = 1.4.0
      node node_modules/vitest/vitest.mjs run "$COMMS_NATIVE_TEST_FILE" --testNamePattern "$COMMS_NATIVE_TEST_PATTERN" --maxWorkers=1 --reporter=verbose
    ' >> "$private/tests.log" 2>&1
}
for scenario in missing foreign candidate beforeallocation afterselection pending password migration; do
  run_scenario packages/server/test/remote-selected-store-repair.test.ts "^remote selected store repair: ${scenario}$"
done
for scenario in shutdownnormal shutdownforce; do
  run_scenario packages/server/test/remote-publication-shutdown.test.ts "^remote held publication shutdown: ${scenario}$"
done
run_scenario packages/boot/test/remote-foreign-backup-native.test.ts '^a genuine foreign native backup cannot replace the adopted recipient$'

echo "All eight $engine repair/migration, both publication shutdown and foreign-backup rejection scenarios passed."
