#!/bin/sh
# Uses a new disposable container and volume; never touches an existing instance.
set -eu
image=${1:-comms:local}
# Check the immutable tools as the same unprivileged account used by boot.
docker run --rm --read-only --user 1000:1000 --entrypoint /bin/sh "$image" -ec '
    test "$(dpkg --print-architecture)" = amd64
    test -s /etc/ssl/certs/ca-certificates.crt
    pg_dump --version | grep -F "(PostgreSQL) 17.11 "
    pg_restore --version | grep -F "(PostgreSQL) 17.11 "
    mysql --version | grep -F "8.4.11" | grep -F "MySQL Community"
    mysqldump --version | grep -F "8.4.11" | grep -F "MySQL Community"
'
container=
volume=
cleanup() {
	if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
	if [ -n "$volume" ]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM

volume=$(docker volume create)
container=$(docker run --detach --read-only --tmpfs /tmp \
	--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
	--cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
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
test "$(docker exec --user 1000:1000 "$container" id -u)" = 1000
docker exec --user 1000:1003 "$container" sh -ec '
	test -f /data/boot.db && test -f /data/store/comms.db
	test -f /data/app/server.ts && test -f /data/pages/init.md
	test -f /opt/comms/packages/boot/dist/child-keeper.js
	test -f /opt/comms/packages/boot/dist/sqlite-copy-worker.js
	test -f /opt/comms/packages/boot/dist/sqlite-copy-keeper.js
	test -f /opt/comms/packages/boot/dist/preparation-keeper.js
	test -f /data/app/package.json && test -f /data/app/bun.lock
	test -f /data/app/ui/index.html
	test ! -w /opt/comms/packages/boot/dist/index.js
	printf "image persistence probe\n" > /data/pages/image-smoke.txt
'
# Real kernel access checks, not Dockerfile ownership assertions.
docker exec "$container" bun -e 'const pids=(await Bun.file("/proc/1/task/1/children").text()).trim().split(/\s+/); if(pids.length!==1)process.exit(1); const status=await Bun.file(`/proc/${pids[0]}/status`).text(); if(!/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status))process.exit(1);'
docker exec --user 1001:1003 "$container" sh -ec '
    test ! -r /data/boot.db
    test ! -r /data/attempts
    test ! -w /data/gen
    test -r /data/store/comms.db && test -w /data/store/comms.db
    ! sudo -n /opt/comms/deployment/child-keeper >/dev/null 2>&1
'
docker exec --user 1002:1002 "$container" sh -ec '
    test ! -r /data/boot.db && test ! -r /data/store/comms.db
    test ! -w /data/gen
    ! sudo -n /opt/comms/deployment/preparation-keeper >/dev/null 2>&1
'
docker exec --user 1001:1003 "$container" bun -e 'import {Database} from "bun:sqlite"; const db=new Database("/data/store/comms.db"); db.exec("PRAGMA busy_timeout=2000"); db.exec("CREATE TABLE image_ownership_probe(value TEXT)"); db.query("INSERT INTO image_ownership_probe VALUES (?)").run("preserved"); db.close();'
docker restart --time 10 "$container" >/dev/null
port=$(docker port "$container" 8080/tcp | sed 's/.*://')
wait_for_app
docker exec --user 1000:1003 "$container" sh -ec 'test "$(cat /data/pages/image-smoke.txt)" = "image persistence probe"'
docker exec --user 1001:1003 "$container" bun -e 'import {Database} from "bun:sqlite"; const db=new Database("/data/store/comms.db"); if(db.query("SELECT value FROM image_ownership_probe").get().value!=="preserved") process.exit(1); db.close();'
printf '%s\n' 'Image smoke passed: published HTTP port, nonroot process, seeded app/pages, immutable image code, and restart persistence.'
