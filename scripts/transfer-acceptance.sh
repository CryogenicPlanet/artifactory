#!/usr/bin/env bash
# Disposable whole-image transfer acceptance. Board rows are created through public HTTP.
set -euo pipefail
umask 077
source_engine=${1:?source engine}
target_engine=${2:?target engine}
board_image=${3:-comms:transfer-acceptance}
acceptance=${4:-normal}
case "$acceptance:$source_engine:$target_engine" in
  normal:*|activation-crash:sqlite:pg|activation-crash:sqlite:mysql) ;;
  *) echo "Unsupported transfer acceptance mode." >&2; exit 2 ;;
esac
case "$source_engine:$target_engine" in
  sqlite:pg|sqlite:mysql|pg:sqlite|pg:mysql|mysql:sqlite|mysql:pg) ;;
  *) echo 'Expected two distinct supported engines.' >&2; exit 2 ;;
esac
private=$(mktemp -d)
prefix="comms-transfer-${source_engine}-${target_engine}-${RANDOM}-${RANDOM}"
network="$prefix-network"
volume="$prefix-data"
configuration="$prefix-configuration"
board="$prefix-source"
target_board="$prefix-target"
refused_board="$prefix-refused"
transfer="$prefix-command"
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    for container in "$board" "$target_board" "$refused_board" "$transfer"; do
      docker logs --tail 60 "$container" > "$private/$(basename "$container").errors" 2>&1 || true
    done
    # Only bounded, redacted diagnostics leave the private fixture directory.
    python3 - "$private" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1])
for path in root.glob('*.errors'):
    text=path.read_text(errors='replace')[-16384:]
    text=re.sub(r'(?i)(?:postgres(?:ql)?|mysql)://[^\s]+','[DATABASE URL]',text)
    text=re.sub(r'(?i)code\s+\S+','code [REDACTED]',text)
    text=re.sub(r'(?i)\b[a-f0-9]{32,}\b','[SECRET]',text)
    print(path.name+':\n'+text,file=sys.stderr)
PY
  fi
  docker rm -f "$board" "$target_board" "$refused_board" "$transfer" \
    "$prefix-source-database" "$prefix-target-database" "$prefix-check-database" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$configuration" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$private"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$private" "$source_engine" "$target_engine" <<'PY'
import json,pathlib,secrets,sys,uuid
root=pathlib.Path(sys.argv[1]); pairs={}; check_id=str(uuid.uuid4())
for side,engine in [('source',sys.argv[2]),('target',sys.argv[3]),('check',sys.argv[3])]:
    directory=root/side; directory.mkdir(mode=0o700)
    env='RP_ID=localhost\nPUBLIC_ORIGIN=http://localhost:8080\nDATABASE_TLS=false\n'
    if engine=='sqlite':
        base=f'/data/transfers/{check_id}/scratch' if side=='check' else '/data'
        app=f'/data/rehearsals/transfer-check-{check_id}/comms.db' if side=='check' else '/data/store/comms.db'
        pairs[side]={'boot':f'file:{base}/boot.db','app':f'file:{app}'}
    else:
        admin,boot,app=(secrets.token_hex(32) for _ in range(3))
        (directory/'admin-password').write_text(admin)
        (directory/'admin.cnf').write_text('[client]\nuser=root\npassword='+admin+'\n')
        (directory/'operator.env').write_text('COMMS_BOOT_PASSWORD='+boot+'\nCOMMS_APP_PASSWORD='+app+'\n')
        (directory/'mysql-passwords.sql').write_text("SET @boot_password='"+boot+"', @app_password='"+app+"';\n")
        scheme,port=('postgres','5432') if engine=='pg' else ('mysql','3306')
        pairs[side]={'boot':f'{scheme}://comms_boot:{boot}@{side}-database:{port}/comms_boot',
                     'app':f'{scheme}://comms_app:{app}@{side}-database:{port}/comms_app'}
    env+='DATABASE_URL='+pairs[side]['app']+'\nBOOT_DATABASE_URL='+pairs[side]['boot']+'\n'
    (directory/'board.env').write_text(env)
    for path in directory.iterdir(): path.chmod(0o600)
(root/'transfer.json').write_text(json.dumps({'version':1,'transfer_id':str(uuid.uuid4()),'mode':'transfer',
    'source':pairs['source'],'target':pairs['target'],'tls':False}))
(root/'transfer.json').chmod(0o600)
(root/'check.json').write_text(json.dumps({'version':1,'transfer_id':check_id,'mode':'check',
    'source':pairs['source'],'target':pairs['check'],'tls':False}))
(root/'check.json').chmod(0o600)
(root/'check-id').write_text(check_id)
PY
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker volume create "$configuration" >/dev/null
provision() {
  local side=$1 engine=$2 database="$prefix-$1-database"
  [ "$engine" != sqlite ] || return 0
  if [ "$engine" = pg ]; then
    docker run --detach --name "$database" --network "$network" --network-alias "$side-database" \
      --mount "type=bind,src=$private/$side,dst=/run/secrets,readonly" \
      --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password \
      'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0' >/dev/null
  else
    docker run --detach --name "$database" --network "$network" --network-alias "$side-database" \
      --mount "type=bind,src=$private/$side,dst=/run/secrets,readonly" \
      --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/admin-password --env MYSQL_ROOT_HOST=127.0.0.1 \
      'mysql:8.4.11@sha256:3466ba4a4828aa8d46fb7c3bc16b67b781c98413cf4ea0fac6feaa6e881faa26' \
      --performance-schema-session-connect-attrs-size=2048 >/dev/null
  fi
  local ready=false
  for attempt in $(seq 1 120); do
    if [ "$engine" = pg ]; then
      if docker exec "$database" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>"$private/$side-readiness.errors"; then ready=true; break; fi
    elif docker exec "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --host=127.0.0.1 \
      -e 'SELECT 1' >/dev/null 2>"$private/$side-readiness.errors"; then ready=true; break; fi
    [ "$(docker inspect --format '{{.State.Running}}' "$database")" = true ] || return 1
    sleep 1
  done
  [ "$ready" = true ] || return 1
  if [ "$engine" = pg ]; then
    docker exec --env-file "$private/$side/operator.env" -i "$database" psql -X -U postgres -v ON_ERROR_STOP=1 \
      < packages/boot/sql/postgres-roles.sql >/dev/null 2>"$private/$side-provision.errors"
    docker exec -i "$database" psql -X -U postgres -v ON_ERROR_STOP=1 \
      < packages/boot/sql/postgres-scratch-roles.sql >/dev/null 2>>"$private/$side-provision.errors"
  else
    cat "$private/$side/mysql-passwords.sql" packages/boot/sql/mysql-roles.sql |
      docker exec -i "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --batch \
        >/dev/null 2>"$private/$side-provision.errors"
    docker exec -i "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --batch \
      < packages/boot/sql/mysql-scratch-roles.sql >/dev/null 2>>"$private/$side-provision.errors"
    if [ "$side" = source ]; then
      docker exec -i "$database" mysql --defaults-extra-file=/run/secrets/admin.cnf --batch \
        < packages/boot/sql/mysql-transfer-roles.sql >/dev/null 2>>"$private/$side-provision.errors"
    fi
  fi
}
provision source "$source_engine"
provision target "$target_engine"
provision check "$target_engine"
capabilities=(--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP)
launch_board() {
  docker run --detach --name "$1" --network "$network" --read-only --tmpfs /tmp \
    "${capabilities[@]}" --mount "type=volume,src=$volume,dst=/data" \
    --env-file "$private/$2/board.env" --publish 127.0.0.1:8080:8080 "$board_image" >/dev/null
}
wait_for_board() {
  for attempt in $(seq 1 240); do
    if curl --fail --silent --max-time 2 http://localhost:8080/init >/dev/null; then return 0; fi
    [ "$(docker inspect --format '{{.State.Running}}' "$1")" = true ] || return 1
    sleep 1
  done
  echo 'Board readiness deadline exceeded.' >&2
  return 1
}
# Effect's default teardown returns 130 after a SIGTERM interruption and completed finalizers.
# A stopped container is not remote closure proof; the transfer command still verifies its receipts.
stop_board() {
  local container=$1 phase=$2 state
  echo "Transfer stopping board: phase=$phase"
  docker stop --time 30 "$container" >/dev/null
  state=$(docker inspect --format '{{.State.Running}}:{{.State.OOMKilled}}:{{.State.ExitCode}}' "$container")
  case "$state" in
    false:false:0|false:false:130) echo "Transfer stopped board: phase=$phase state=$state" ;;
    *) echo "Transfer stop failed: phase=$phase state=$state" >&2; return 1 ;;
  esac
}
launch_board "$board" source
wait_for_board "$board"
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
export COMMS_TEST_DIAGNOSTICS_FILE="$private/http-diagnostics"
bun scripts/remote-board-http.ts prepare http://localhost:8080 "$private/state.json"
bun scripts/transfer-acceptance-http.ts seed-source http://localhost:8080 "$private/state.json"
stop_board "$board" source-seeded
# The real wrapper requires a root-owned, non-writable ancestor chain. Host runner UID
# ownership is not enough; copy each private config into a root-owned disposable volume.
run_transfer() {
  local mode=$1 expectation=${2:-complete} exit_code=0
  local mount_wrapper=()
  if [ "$expectation" = crash ]; then
    mount_wrapper=(--mount "type=bind,src=$private/activation-crash.js,dst=/opt/comms/packages/server/dist/store-transfer.js,readonly")
  fi
  docker run --rm --network none --read-only --user 0:0 --entrypoint /bin/sh \
    --mount "type=bind,src=$private,dst=/input,readonly" \
    --mount "type=volume,src=$configuration,dst=/run/secrets" "$board_image" \
    -c 'chmod 0700 /run/secrets; cp "/input/$1.json" /run/secrets/transfer.json; chown 0:0 /run/secrets/transfer.json; chmod 0600 /run/secrets/transfer.json' transfer-config "$mode"
  docker run "${mount_wrapper[@]}" --name "$transfer" --network "$network" --read-only --tmpfs /tmp "${capabilities[@]}" \
    --mount "type=volume,src=$volume,dst=/data" \
    --mount "type=volume,src=$configuration,dst=/run/secrets,readonly" \
    "$board_image" store-transfer --config /run/secrets/transfer.json \
    > "$private/$mode-output" 2> "$private/$mode.errors" || exit_code=$?
  if [ "$expectation" != complete ]; then
    if [ "$expectation" = crash ]; then
      [ "$exit_code" = 137 ]
      grep -q '^Instrumented outer checkpoint: final activation rename$' "$private/$mode.errors"
    else
      [ "$exit_code" = 1 ]
      [ ! -s "$private/$mode-output" ]
    fi
    docker rm "$transfer" >/dev/null
    return
  fi
  [ "$exit_code" = 0 ]
  python3 - "$private" "$source_engine" "$target_engine" "$mode" <<'PY_RESULT'
import json,pathlib,re,sys
root=pathlib.Path(sys.argv[1]); mode=sys.argv[4]; config=json.loads((root/(mode+'.json')).read_text())
result=json.loads((root/(mode+'-output')).read_text())
assert result['transfer_id']==config['transfer_id'], 'CLI transfer identity missing'
assert result['status']==('checked' if mode=='check' else 'complete'), 'CLI completion receipt missing'
assert result['source']['engine']==sys.argv[2] and result['target']['engine']==sys.argv[3], 'Wrong transfer engines'
assert re.fullmatch('[a-f0-9]{64}',result['manifest']), 'Verified manifest missing'
assert '://' not in json.dumps(result), 'Public CLI output contains a connection URL'
PY_RESULT
  docker rm "$transfer" >/dev/null
}
run_transfer check
# The scratch target is intentionally not startable, but must contain no copied business rows.
if [ "$target_engine" = sqlite ]; then
  check_id=$(cat "$private/check-id")
  docker run --rm --network none --read-only --user 0:0 --entrypoint /usr/local/bin/bun \
    --mount "type=volume,src=$volume,dst=/data,readonly" \
    --mount "type=bind,src=$PWD/scripts,dst=/opt/comms/scripts,readonly" "$board_image" \
    /opt/comms/scripts/transfer-acceptance-inspect.ts \
    "/data/transfers/$check_id/scratch/boot.db" "/data/rehearsals/transfer-check-$check_id/comms.db"
else
  if [ "$target_engine" = pg ]; then
    check_sql() { docker exec "$prefix-check-database" psql -X -U postgres -d "$1" -At -v ON_ERROR_STOP=1 -c "$2"; }
  else
    check_sql() { docker exec "$prefix-check-database" mysql --defaults-extra-file=/run/secrets/admin.cnf --database="$1" --batch --skip-column-names -e "$2"; }
  fi
  [ "$(check_sql comms_app 'SELECT COUNT(*) FROM messages')" = 0 ]
  [ "$(check_sql comms_boot 'SELECT COUNT(*) FROM passkeys')" = 0 ]
  [ "$(check_sql comms_boot 'SELECT COUNT(*) FROM generations')" = 0 ]
  if [ "$target_engine" = pg ]; then
    marker=$(check_sql comms_boot "SELECT value FROM settings WHERE key='transfer_state'")
  else
    marker=$(check_sql comms_boot 'SELECT value FROM settings WHERE `key`='"'transfer_state'")
  fi
  case "$marker" in in_progress) ;; *) echo 'Check target became eligible for startup.' >&2; exit 1 ;; esac
fi
docker start "$board" >/dev/null
wait_for_board "$board"
bun scripts/transfer-acceptance-http.ts verify-checked-source http://localhost:8080 "$private/state.json"
stop_board "$board" source-checked
if [ "$acceptance" = activation-crash ]; then
  # This deliberately instruments only the outer activation boundary; normal resume uses the real CLI.
  source scripts/transfer-acceptance-activation.sh
fi
run_transfer transfer
launch_board "$refused_board" source
for attempt in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Running}}' "$refused_board")" = true ] || break
  if curl --silent --max-time 1 http://localhost:8080/health >/dev/null; then
    bun scripts/transfer-acceptance-http.ts verify-source-refused http://localhost:8080 "$private/state.json"
    break
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Running}}' "$refused_board")" != true ]; then
  [ "$(docker inspect --format '{{.State.ExitCode}}' "$refused_board")" != 0 ]
  docker logs "$refused_board" > "$private/source-refusal" 2>&1
  grep -q 'store_transferred' "$private/source-refusal"
else
  # A live listener must demonstrate the typed refusal, not just fail a readiness probe.
  bun scripts/transfer-acceptance-http.ts verify-source-refused http://localhost:8080 "$private/state.json"
  docker stop --time 30 "$refused_board" >/dev/null
fi
launch_board "$target_board" target
wait_for_board "$target_board"
bun scripts/transfer-acceptance-http.ts verify-target http://localhost:8080 "$private/state.json"
docker restart --time 30 "$target_board" >/dev/null
wait_for_board "$target_board"
bun scripts/transfer-acceptance-http.ts verify-restarted http://localhost:8080 "$private/state.json"
stop_board "$target_board" target-restarted
echo "Actual image transfer $source_engine -> $target_engine passed persisted board and restart checks."
