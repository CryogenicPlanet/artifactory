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
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
const locks = readdirSync('/proc/self/fd').filter(fd => {
  try { return readlinkSync('/proc/self/fd/' + fd) === '/data/.comms-lifetime.lock'; }
  catch { return false; }
});
if (process.argv[2] === 'child') process.exit(locks.length === 0 ? 0 : 1);
if (locks.length !== 1) throw new Error('Root must own exactly one lifetime lock');
const child = Bun.spawnSync([process.execPath, import.meta.filename, 'child']);
if (child.exitCode !== 0) throw new Error('Lifetime lock leaked into a subprocess');
if (process.argv[2] === 'finish') process.exit(0);
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
run() {
  docker run "$@" --read-only --tmpfs /tmp --cap-drop ALL \
    --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
    --mount "type=volume,src=$volume,dst=/data" \
    --mount "type=bind,src=$private/store-transfer.js,dst=/opt/comms/packages/server/dist/store-transfer.js,readonly" \
    "$image" store-transfer
}
container=$(run --detach)
wait_for() {
  count=0
  until docker logs "$container" 2>/dev/null | grep -q "$1"; do
    count=$((count + 1))
    [ "$count" -lt 50 ] || { echo 'Lifetime fixture did not reach barrier' >&2; exit 1; }
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
  --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
  --mount "type=volume,src=$volume,dst=/data" \
  --mount "type=bind,src=$private/store-transfer.js,dst=/opt/comms/packages/server/dist/store-transfer.js,readonly" \
  "$image" store-transfer finish >/dev/null || code=$?
test "$code" = 0
printf '%s\n' 'Lifetime lock: root ownership, no child fd leak, delayed shutdown exclusion and reopen passed.'
