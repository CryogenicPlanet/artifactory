#!/usr/bin/env bash
# Real board acceptance on disposable databases, image and volume. No SQL seeding of board state.
set -euo pipefail
umask 077
engine=${1:?pg or mysql}
board_image=${2:-comms:acceptance}
case "$engine" in
  pg) database_image='postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0' ;;
  mysql) database_image='mysql:8.4.11@sha256:3466ba4a4828aa8d46fb7c3bc16b67b781c98413cf4ea0fac6feaa6e881faa26' ;;
  *) exit 2 ;;
esac
if [ "$engine" = mysql ] && [ ! -f packages/boot/sql/mysql-scratch-roles.sql ]; then
  echo 'MySQL board acceptance requires the reviewed scratch-role operator script; backup/restore is not optional.' >&2
  exit 1
fi
private=$(mktemp -d)
prefix="comms-board-${engine}-${RANDOM}-${RANDOM}"
network="$prefix-network"
database="$prefix-database"
board="$prefix-board"
volume="$prefix-data"
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    echo "Remote board acceptance failed ($engine)." >&2
    docker logs --tail 80 "$board" > "$private/board-errors" 2>&1 || true
    # Fixture secrets and setup enrollment codes never enter CI output or artifacts.
    python3 - "$private" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1])
for name in ['provision-errors','readiness-errors','board-errors']:
    path=root/name
    if path.exists():
        text=path.read_text(errors='replace')
        text=re.sub(r'(?i)(?:postgres(?:ql)?|mysql)://[^\s]+','[DATABASE URL REDACTED]',text)
        text=re.sub(r'(?i)code\s+\S+','code [REDACTED]',text)
        text=re.sub(r'(?i)\b[a-f0-9]{32,}\b','[SECRET REDACTED]',text)
        print(name+':\n'+text,file=sys.stderr)
PY
  fi
  docker rm -f "$board" "$database" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$private"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$private" "$engine" <<'PY'
import pathlib,secrets,sys
root=pathlib.Path(sys.argv[1]); engine=sys.argv[2]
admin,boot,app=(secrets.token_hex(32) for _ in range(3))
(root/'admin-password').write_text(admin)
(root/'admin.cnf').write_text('[client]\nuser=root\npassword='+admin+'\n')
(root/'app.cnf').write_text('[client]\nuser=comms_app\npassword='+app+'\nprotocol=TCP\nhost=127.0.0.1\n')
(root/'operator.env').write_text('COMMS_BOOT_PASSWORD='+boot+'\nCOMMS_APP_PASSWORD='+app+'\n')
(root/'app.env').write_text('PGPASSWORD='+app+'\n')
(root/'mysql-passwords.sql').write_text("SET @boot_password='"+boot+"', @app_password='"+app+"';\n")
scheme,port=('postgres','5432') if engine=='pg' else ('mysql','3306')
(root/'board.env').write_text(f'DATABASE_URL={scheme}://comms_app:{app}@database:{port}/comms_app\nBOOT_DATABASE_URL={scheme}://comms_boot:{boot}@database:{port}/comms_boot\nDATABASE_TLS=false\nRP_ID=localhost\nPUBLIC_ORIGIN=http://localhost:8080\n')
for path in root.iterdir(): path.chmod(0o600)
PY
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
if [ "$engine" = pg ]; then
  docker run --detach --name "$database" --network "$network" --network-alias database \
    --mount "type=bind,src=$private,dst=/run/secrets,readonly" \
    --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password "$database_image" >/dev/null
  ready() { docker exec "$database" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>"$private/readiness-errors"; }
else
  docker run --detach --name "$database" --network "$network" --network-alias database \
    --mount "type=bind,src=$private,dst=/run/secrets,readonly" \
    --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/admin-password --env MYSQL_ROOT_HOST=127.0.0.1 \
    "$database_image" --performance-schema-session-connect-attrs-size=2048 >/dev/null
  ready() { docker exec "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --host=127.0.0.1 -e 'SELECT 1' >/dev/null 2>"$private/readiness-errors"; }
fi
for attempt in $(seq 1 120); do
  if ready; then break; fi
  if [ "$attempt" = 120 ] || [ "$(docker inspect --format '{{.State.Running}}' "$database")" != true ]; then exit 1; fi
  sleep 1
done
if [ "$engine" = pg ]; then
  docker exec --env-file "$private/operator.env" -i "$database" psql -X -U postgres -v ON_ERROR_STOP=1 \
    < packages/boot/sql/postgres-roles.sql >/dev/null 2>"$private/provision-errors"
  docker exec -i "$database" psql -X -U postgres -v ON_ERROR_STOP=1 \
    < packages/boot/sql/postgres-scratch-roles.sql >/dev/null 2>>"$private/provision-errors"
  docker exec --env-file "$private/app.env" "$database" psql -X -h 127.0.0.1 -U comms_app -d comms_app -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>"$private/denial"
  if docker exec --env-file "$private/app.env" "$database" psql -X -h 127.0.0.1 -U comms_app -d comms_boot -c 'SELECT 1' >"$private/denial" 2>&1; then
    echo 'App role unexpectedly accessed the boot database.' >&2; exit 1
  fi
else
  cat "$private/mysql-passwords.sql" packages/boot/sql/mysql-roles.sql |
    docker exec -i "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --batch >/dev/null 2>"$private/provision-errors"
  # Exact scratch privileges come from the reviewed operator script, never inline broad CI grants.
  docker exec -i "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --batch \
    < packages/boot/sql/mysql-scratch-roles.sql >/dev/null 2>>"$private/provision-errors"
  docker exec "$database" mysql --defaults-extra-file=/run/secrets/app.cnf --database=comms_app -e 'SELECT 1' >/dev/null 2>"$private/denial"
  if docker exec "$database" mysql --defaults-extra-file=/run/secrets/app.cnf --database=comms_boot -e 'SELECT 1' >"$private/denial" 2>&1; then
    echo 'App role unexpectedly accessed the boot database.' >&2; exit 1
  fi
fi
docker run --detach --name "$board" --network "$network" --read-only --tmpfs /tmp \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
  --mount "type=volume,src=$volume,dst=/data" --env-file "$private/board.env" \
  --publish 127.0.0.1:8080:8080 "$board_image" >/dev/null
wait_for_board() {
  for attempt in $(seq 1 240); do
    if curl --fail --silent --max-time 2 http://localhost:8080/init >/dev/null; then return; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$board")" != true ]; then return 1; fi
    sleep 1
  done
  echo 'Board readiness deadline exceeded.' >&2
  return 1
}
wait_for_board
docker logs "$board" > "$private/setup-output" 2>&1
python3 - "$private" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1]); text=(root/'setup-output').read_text()
match=re.search(r'code\s+([A-Fa-f0-9-]{8,})',text)
if not match: raise SystemExit('Setup code absent from board output')
(root/'setup-code').write_text(match[1]); (root/'setup-code').chmod(0o600)
PY
export COMMS_TEST_ORIGIN=http://localhost:8080
export COMMS_SETUP_CODE_FILE="$private/setup-code"
bun scripts/remote-board-http.ts prepare http://localhost:8080 "$private/state.json"
bun scripts/remote-board-http.ts failed-health http://localhost:8080 "$private/state.json"
marker_path=$(bun -e 'const value = await Bun.file(process.argv[1]).json(); if (!Number.isSafeInteger(value.failedGeneration) || value.failedGeneration < 1 || !/^native-candidate-health-[a-f0-9-]+\.json$/.test(value.marker) || value.markerPath !== `/data/gen/${value.failedGeneration}/source.board/${value.marker}`) process.exit(1); process.stdout.write(value.markerPath)' "$private/state.json.health")
docker exec "$board" cat "$marker_path" > "$private/state.json.health-marker"
bun scripts/remote-board-http.ts check-health-marker http://localhost:8080 "$private/state.json"
docker restart --time 30 "$board" >/dev/null
wait_for_board
bun scripts/remote-board-http.ts check-restarted http://localhost:8080 "$private/state.json"
echo "Real $engine board passed public authentication, domain writes, idempotency, backup/restore and restart durability."
