#!/bin/sh
# Uses only a disposable image command, fixture, container and volume.
set -eu
image=${1:-comms:local}
private=$(mktemp -d)
container=
volume=
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if [ -n "$volume" ]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
  rm -rf "$private"
}
trap cleanup EXIT HUP INT TERM
cat > "$private/store-transfer.js" <<'JS'
import { closeSync, existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
const locks = readdirSync('/proc/self/fd').filter(fd => {
  try { return readlinkSync('/proc/self/fd/' + fd) === '/data/.comms-lifetime.lock'; }
  catch { return false; }
});
const configs = readdirSync('/proc/self/fd').filter(fd => {
  try { return readlinkSync('/proc/self/fd/' + fd) === '/data/transfer-config.json'; }
  catch { return false; }
});
if (process.argv[2] === 'child') process.exit(locks.length === 0 && configs.length === 0 ? 0 : 1);
if (process.argv[2] !== '--config-stdin' || configs.length !== 1 || configs[0] !== '0')
  throw new Error('Config must arrive only on stdin');
if (readFileSync(0, 'utf8') !== '{"fixture":true}') throw new Error('Config handoff failed');
closeSync(0);
if (locks.length !== 1) throw new Error('Root must own exactly one lifetime lock');
const child = Bun.spawnSync([process.execPath, import.meta.filename, 'child']);
if (child.exitCode !== 0) throw new Error('Lifetime lock leaked into a subprocess');
if (process.env.COMMS_TEST_FINISH === '1') process.exit(0);
process.on('SIGTERM', () => {
  process.stdout.write('STOPPING\n');
  setInterval(() => { if (existsSync('/tmp/lifetime-release')) process.exit(0); }, 20);
});
process.stdout.write('STARTED\n');
setInterval(() => {}, 1000);
JS
chmod 755 "$private"
chmod 644 "$private/store-transfer.js"
volume=$(docker volume create)
docker run --rm --entrypoint /bin/sh --mount "type=volume,src=$volume,dst=/data" "$image" -c \
  'umask 077; printf %s "{\"fixture\":true}" > /data/transfer-config.json'
# Tini remains root and needs KILL to forward signals to the boot-UID child.
run() {
  docker run "$@" --read-only --tmpfs /tmp --cap-drop ALL \
    --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
    --mount "type=volume,src=$volume,dst=/data" \
    --mount "type=bind,src=$private/store-transfer.js,dst=/opt/comms/packages/server/dist/store-transfer.js,readonly" \
    "$image" store-transfer --config "${fixture_config:-/data/transfer-config.json}"
}
container=$(run --detach)
failed() {
  echo "Lifetime fixture failed at $1" >&2
  # This container runs only the synthetic fixture/config above. Never dump its
  # environment or an operator's config; retain the actual error before cleanup.
  docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$container" >&2 || true
  docker logs --tail 80 "$container" >&2 || true
  exit 1
}
wait_for() {
  count=0
  until docker logs "$container" 2>/dev/null | grep -q "$1"; do
    count=$((count + 1))
    case "$(docker inspect --format '{{.State.Status}}' "$container")" in
      exited|dead) failed "$1: container exited" ;;
    esac
    [ "$count" -lt 50 ] || failed "$1: barrier not reached"
    sleep 0.1
  done
}
refused() {
  code=0
  run --rm >/dev/null 2>&1 || code=$?
  test "$code" = 75
}
wait_for STARTED
refused
docker kill --signal TERM "$container" >/dev/null
wait_for STOPPING
refused
docker exec "$container" touch /tmp/lifetime-release
test "$(docker wait "$container")" = 0
# A completed command released the same retained lock inode.
code=0
# Use a new short-lived command by overriding only fixture input, not the entrypoint.
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
  --mount "type=volume,src=$volume,dst=/data" \
  --mount "type=bind,src=$private/store-transfer.js,dst=/opt/comms/packages/server/dist/store-transfer.js,readonly" \
  --env COMMS_TEST_FINISH=1 "$image" store-transfer --config /data/transfer-config.json >/dev/null || code=$?
test "$code" = 0
prepare() {
  docker run --rm --entrypoint /bin/sh --mount "type=volume,src=$volume,dst=/data" "$image" -c "$1"
}
invalid() {
  code=0
  run --rm --env COMMS_TEST_FINISH=1 >/dev/null 2>&1 || code=$?
  test "$code" = 64
}
prepare 'chmod 644 /data/transfer-config.json'
invalid
prepare 'chmod 600 /data/transfer-config.json; ln -s transfer-config.json /data/config-link'
fixture_config=/data/config-link
invalid
prepare 'mkdir /data/writable; chmod 777 /data/writable; cp /data/transfer-config.json /data/writable/config; chmod 600 /data/writable/config'
fixture_config=/data/writable/config
invalid
printf '%s\n' 'Lifetime lock and private config handoff: ownership, child exclusion, shutdown, reopen and unsafe path refusal passed.'
