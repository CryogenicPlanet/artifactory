#!/bin/sh
# Uses a new disposable container and volume; never touches an existing instance.
set -eu
image=${1:-comms:local}
container=
volume=
cleanup() {
	if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
	if [ -n "$volume" ]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM

volume=$(docker volume create)
container=$(docker run --detach --read-only --tmpfs /tmp \
	--cap-drop ALL --security-opt no-new-privileges \
	--mount "type=volume,src=$volume,dst=/data" \
	--publish 127.0.0.1::8080 "$image")
port=$(docker port "$container" 8080/tcp | sed 's/.*://')
wait_for_app() {
	attempt=0
	while ! curl --fail --silent --max-time 2 "http://127.0.0.1:$port/init.md" >/dev/null; do
		attempt=$((attempt + 1))
		if [ "$attempt" -ge 200 ]; then
			echo 'Image did not serve onboarding after 200 bounded attempts.' >&2
			return 1
		fi
		sleep 1
	done
}
wait_for_app
curl --fail --silent --max-time 2 "http://127.0.0.1:$port/health" >/dev/null
test "$(docker exec "$container" id -u)" = 1000
docker exec "$container" sh -ec '
	test -f /data/boot.db && test -f /data/comms.db
	test -f /data/app/server.ts && test -f /data/pages/init.md
	test -f /opt/comms/packages/boot/dist/child-keeper.js
	test -f /opt/comms/packages/boot/dist/preparation-keeper.js
	test -f /data/app/package.json && test -f /data/app/bun.lock
	test -f /data/app/ui/index.html
	test ! -w /opt/comms/packages/boot/dist/index.js
	printf "image persistence probe\n" > /data/pages/image-smoke.txt
'
docker restart --time 10 "$container" >/dev/null
port=$(docker port "$container" 8080/tcp | sed 's/.*://')
wait_for_app
docker exec "$container" sh -ec 'test "$(cat /data/pages/image-smoke.txt)" = "image persistence probe"'
printf '%s\n' 'Image smoke passed: published HTTP port, nonroot process, seeded app/pages, immutable image code, and restart persistence.'
