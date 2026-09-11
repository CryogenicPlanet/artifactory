#!/bin/sh
# Kernel acceptance only: requires Linux Docker and the UID-isolated image.
# Every resource is disposable. Container restart is not a machine reboot test.
set -eu
image=${1:-comms:local}
container=
volume=
cleanup() {
	if [ -n "$container" ]; then docker logs "$container" >&2 || true; docker rm -f "$container" >/dev/null 2>&1 || true; fi
	if [ -n "$volume" ]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM
volume=$(docker volume create)
container=$(docker run --detach --init --read-only --tmpfs /tmp \
	--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
	--cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
	--mount "type=volume,src=$volume,dst=/data" --entrypoint /bin/sh "$image" -c 'exec sleep 300')
docker exec "$container" /usr/local/bin/bun /opt/comms/packages/boot/dist/deployment-layout.js
docker exec "$container" sh -ec '
	mkdir -p /data/attempts /data/gen/1/source /data/prepared/legacy /data/cache/.prepare-probe/workspace/node_modules/vite/bin /data/cache/.prepare-probe/workspace/ui
	chown 1000:1000 /data/attempts /data/boot.db
	chmod 700 /data/attempts
	chmod 600 /data/boot.db
	printf "export const retained = true;\n" > /data/prepared/legacy/probe.js
	chown -R 1000:1000 /data/prepared
	chmod 700 /data/prepared /data/prepared/legacy
	chmod 600 /data/prepared/legacy/probe.js
'
# SQLite inherits its sidecar permissions from the pre-created private main file.
docker exec -i "$container" sh -c 'cat > /tmp/private-writer.js' <<'JS'
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database("/data/boot.db");
db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE private_probe(value TEXT)");
db.query("INSERT INTO private_probe VALUES (?)").run("retained WAL identity");
writeFileSync("/data/private-writer.pid", String(process.pid));
setInterval(() => {}, 1000);
JS
docker exec --detach "$container" setpriv --reuid=1000 --regid=1000 --groups=1003 bun /tmp/private-writer.js
tries=0
until docker exec "$container" test -f /data/private-writer.pid; do
    tries=$((tries+1)); test "$tries" -lt 100; sleep 0.1
done
private_files() {
    docker exec "$container" sh -ec 'test -f /data/boot.db-wal && test -f /data/boot.db-shm'
    for uid in 1001:1003 1002:1002; do
        docker exec --user "$uid" "$container" sh -ec 'test ! -r /data/boot.db && test ! -r /data/boot.db-wal && test ! -r /data/boot.db-shm'
    done
}
private_files
docker exec "$container" sh -ec 'kill -KILL "$(cat /data/private-writer.pid)"'
# Simulate permissions left by the former flat, single-UID image. No editable
# process has been launched in this disposable container yet.
docker exec "$container" chmod 0644 /data/boot.db /data/boot.db-wal /data/boot.db-shm
docker exec "$container" /usr/local/bin/bun /opt/comms/packages/boot/dist/deployment-layout.js
private_files
docker exec --user 1000:1000 "$container" bun -e 'import {Database} from "bun:sqlite"; const db=new Database("/data/boot.db");if(db.query("SELECT value FROM private_probe").get().value!=="retained WAL identity")process.exit(1);db.close();'
printf '%s\n' 'Passed fresh and legacy crash WAL privacy with retained committed data.'
# The editable process checks its actual kernel identity, then spawns an ordinary
# SQLite writer in its inherited process group. No escaped sessions are claimed.
docker exec -i "$container" sh -c 'cat > /data/gen/1/source/probe.js' <<'JS'
import { Database } from "bun:sqlite";
import { retained } from "/data/prepared/legacy/probe.js";
if (!retained) throw new Error("legacy prepared dependency unavailable");
import { readFileSync, writeFileSync, accessSync, existsSync, constants } from "node:fs";
function deny(path, mode) {
  try { accessSync(path, mode); } catch { return; }
  throw new Error(`unexpected access: ${path}`);
}
function identity(uid) {
  if (process.getuid() !== uid) throw new Error(`wrong UID ${process.getuid()}`);
  const status = readFileSync("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(status)) throw new Error("NoNewPrivs missing");
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    if (!new RegExp(`^${name}:\\s+0+$`, "m").test(status)) throw new Error(`${name} nonzero`);
  deny("/data/boot.db", constants.R_OK);
  deny(import.meta.path, constants.W_OK);
}
identity(1001);
if (process.env.PROBE_DESCENDANT === "1") {
  const db = new Database(process.env.APP_DATABASE);
  db.exec("CREATE TABLE IF NOT EXISTS keeper_probe(value INTEGER NOT NULL); INSERT INTO keeper_probe SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM keeper_probe)");
  let writes = 0;
  setInterval(() => {
    db.exec("UPDATE keeper_probe SET value=value+1");
    if (++writes === 3) writeFileSync("/data/runtime/writer-ready", "ready");
  }, 30);
} else {
  Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, PROBE_DESCENDANT: "1" }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  writeFileSync("/data/runtime/identity.json", JSON.stringify({ uid: process.getuid() }));
  if (process.env.EXIT_LEADER === "1") {
    setTimeout(() => process.exit(1), 10000);
    setInterval(() => { if (existsSync("/data/runtime/writer-ready")) process.exit(0); }, 20);
  }
  else setInterval(() => {}, 1000);
}
JS
# A real boot-UID owner retains the helper stdin pipe. SIGKILL must close it.
docker exec -i "$container" sh -c 'cat > /tmp/keeper-owner.js' <<'JS'
import { writeFileSync } from "node:fs";
const attempt = process.argv[2];
const helper = Bun.spawn(["/usr/bin/sudo", "-n", "/opt/comms/deployment/child-keeper"], {
  env: { COMMS_CHILD_CONFIG: JSON.stringify({
    entry: "/data/gen/1/source/probe.js", cwd: "/data/gen/1/source", attempt,
    receipt: `/data/attempts/${attempt}.closed`,
    env: { APP_DATABASE: "/data/store/comms.db", STATE: "candidate", EXIT_LEADER: process.argv[3] },
  }) }, stdin: "pipe", stdout: "inherit", stderr: "inherit",
});
writeFileSync("/data/owner.pid", String(process.pid));
await helper.exited;
process.exit(helper.exitCode ?? 1);
JS
counter() {
	docker exec "$container" bun -e 'import {Database} from "bun:sqlite"; const db=new Database("/data/store/comms.db",{readonly:true}); console.log(db.query("SELECT value FROM keeper_probe").get().value);db.close();'
}
wait_for() {
	tries=0
	until "$@"; do
		tries=$((tries + 1))
		if [ "$tries" -ge 100 ]; then
			docker exec "$container" sh -c 'cat /data/keeper.log' >&2 || true
			echo "Timed out: $*" >&2
			return 1
		fi
		sleep 0.1
	done
}
writing() { value=$(counter 2>/dev/null) || return 1; [ "$value" -ge 3 ]; }
closed() { docker exec --user 1000:1000 "$container" sh -ec 'test "$(cat "$1")" = "$2"' sh "/data/attempts/$attempt.closed" "$attempt" 2>/dev/null; }
for mode in killed-owner exited-leader; do
	if [ "$mode" = killed-owner ]; then attempt=$(printf '%064d' 1); exit_leader=0; else attempt=$(printf '%064d' 2); exit_leader=1; fi
	docker exec "$container" sh -ec 'rm -f /data/owner.pid /data/runtime/identity.json /data/runtime/writer-ready; if [ -f /data/store/comms.db ]; then bun -e '\''import {Database} from "bun:sqlite"; const db=new Database("/data/store/comms.db");db.exec("UPDATE keeper_probe SET value=0");db.close();'\''; fi'
	docker exec --detach "$container" sh -c 'exec setpriv --reuid=1000 --regid=1000 --groups=1003 bun /tmp/keeper-owner.js "$1" "$2" > /data/keeper.log 2>&1' sh "$attempt" "$exit_leader"
	wait_for writing
	docker exec "$container" bun -e 'if((await Bun.file("/data/runtime/identity.json").json()).uid!==1001)process.exit(1)'
	if [ "$mode" = killed-owner ]; then
		docker exec "$container" sh -ec 'kill -KILL "$(cat /data/owner.pid)"'
	fi
	wait_for closed
	before=$(counter)
	test "$before" -ge 3
	sleep 0.5
	test "$(counter)" = "$before"
	printf '%s\n' "Passed $mode: app UID/capabilities/access, closure receipt, stable SQLite counter."
done
# Fake editable Vite entry runs through the real fixed preparation keeper.
docker exec -i "$container" sh -c 'cat > /data/cache/.prepare-probe/workspace/node_modules/vite/bin/vite.js' <<'JS'
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
if (process.getuid() !== 1002) throw new Error("build UID");
const status = readFileSync("/proc/self/status", "utf8");
if (!/^NoNewPrivs:\s+1$/m.test(status)) throw new Error("build NoNewPrivs");
for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
  if (!new RegExp(`^${name}:\\s+0+$`, "m").test(status)) throw new Error(`build ${name}`);
for (const path of ["/data/boot.db", "/data/store/comms.db"])
  for (const mode of [constants.R_OK, constants.W_OK]) {
    let denied = false;
    try { accessSync(path, mode); } catch { denied = true; }
    if (!denied) throw new Error(`build accessed ${path}`);
  }
writeFileSync("../build-proof.json", JSON.stringify({ uid: process.getuid() }));
JS
docker exec -i "$container" sh -c 'cat > /tmp/preparation-owner.js' <<'JS'
const helper = Bun.spawn(["/usr/bin/sudo", "-n", "/opt/comms/deployment/preparation-keeper"], {
  env: { COMMS_PREPARATION_CONFIG: JSON.stringify({ operation: "build",
    workspace: "/data/cache/.prepare-probe/workspace", output: "/data/cache/.prepare-probe/workspace/board" }) },
  stdin: "pipe", stdout: "inherit", stderr: "inherit",
});
const timeout = setTimeout(() => { helper.kill(); process.exit(1); }, 15000);
const code = await helper.exited;
clearTimeout(timeout);
process.exit(code);
JS
docker exec "$container" setpriv --reuid=1000 --regid=1000 --groups=1003 bun /tmp/preparation-owner.js
docker exec --user 1000:1000 "$container" bun -e 'import {statSync} from "node:fs"; const workspace="/data/cache/.prepare-probe/workspace"; const proof=workspace+"/build-proof.json"; if((await Bun.file(proof).json()).uid!==1002 || statSync(proof).uid!==1000 || statSync(workspace).uid!==1000 || (statSync(workspace).mode & 511)!==448)process.exit(1)'
printf '%s\n' 'Passed build UID, capabilities, live/boot store denial and boot-owned result reclamation. This does not test machine reboot or escaped sessions.'
