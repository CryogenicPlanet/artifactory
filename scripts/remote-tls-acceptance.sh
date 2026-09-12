#!/usr/bin/env bash
# Real production pools and native tools against a disposable private-CA server.
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
prefix="comms-tls-${engine}-${RANDOM}-${RANDOM}"
network="$prefix-network"
server="$prefix-server"
cleanup() {
  docker rm -f "$server" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$prefix-server" "$prefix-trusted" "$prefix-untrusted" >/dev/null 2>&1 || true
  rm -rf "$private"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$private/artifacts" "$private/server" "$private/trusted" "$private/untrusted" "$private/config"
for ca in trusted untrusted; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=comms-fixture-$ca" \
    -keyout "$private/$ca.key" -out "$private/$ca/ca.crt" >/dev/null 2>&1
  cat > "$private/$ca/Dockerfile" <<DOCKER
FROM $board_image
USER 0:0
COPY ca.crt /usr/local/share/ca-certificates/comms-fixture.crt
RUN update-ca-certificates
COPY remote-tls.ts /opt/comms/packages/storage/test/fixtures/remote-tls.ts
DOCKER
  cp packages/storage/test/fixtures/remote-tls.ts "$private/$ca/remote-tls.ts"
  docker build --quiet --tag "$prefix-$ca" "$private/$ca" >"$private/build-$ca.log" 2>&1 || {
    echo "TLS client image preparation failed ($ca)." >&2; exit 1;
  }
done
openssl req -newkey rsa:2048 -nodes -subj '/CN=database.test' \
  -keyout "$private/server/server.key" -out "$private/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:database.test' 'extendedKeyUsage=serverAuth' > "$private/server.ext"
openssl x509 -req -days 2 -in "$private/server.csr" -CA "$private/trusted/ca.crt" \
  -CAkey "$private/trusted.key" -CAcreateserial -extfile "$private/server.ext" \
  -out "$private/server/server.crt" >/dev/null 2>&1
cp "$private/trusted/ca.crt" "$private/server/ca.crt"
server_user=postgres
if [ "$engine" = mysql ]; then server_user=mysql; fi
cat > "$private/server/Dockerfile" <<DOCKER
FROM $database_image
USER root
COPY server.key server.crt ca.crt /tls/
RUN chown -R $server_user /tls && chmod 0755 /tls && chmod 0600 /tls/server.key && chmod 0644 /tls/server.crt /tls/ca.crt
DOCKER
docker build --quiet --tag "$prefix-server" "$private/server" >"$private/build-server.log" 2>&1 || {
  echo 'TLS server image preparation failed.' >&2; exit 1;
}
python3 - "$private/config" "$engine" <<'PY'
import json,pathlib,secrets,sys
root=pathlib.Path(sys.argv[1]); engine=sys.argv[2]
admin,password=secrets.token_hex(32),secrets.token_hex(32)
(root/'admin-password').write_text(admin)
(root/'admin.cnf').write_text('[client]\nuser=root\npassword='+admin+'\n')
(root/'client.json').write_text(json.dumps(dict(engine=engine,password=password)))
if engine=='pg':
 sql=f"CREATE ROLE comms_tls LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nCREATE DATABASE comms_tls OWNER comms_tls;\n"
else:
 sql=f"CREATE USER 'comms_tls'@'%' IDENTIFIED BY '{password}' REQUIRE SSL;\nCREATE DATABASE comms_tls;\nGRANT ALL ON comms_tls.* TO 'comms_tls'@'%';\nGRANT SELECT ON performance_schema.session_account_connect_attrs TO 'comms_tls'@'%';\n"
(root/'roles.sql').write_text(sql)
for path in root.iterdir():path.chmod(0o600)
PY
docker network create "$network" >/dev/null
if [ "$engine" = pg ]; then
  docker run --detach --name "$server" --network "$network" --network-alias database.test --network-alias wrong.test \
    --mount "type=bind,src=$private/config,dst=/run/secrets,readonly" \
    --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password "$prefix-server" \
    -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key >/dev/null
  ready() { docker exec "$server" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; }
else
  docker run --detach --name "$server" --network "$network" --network-alias database.test --network-alias wrong.test \
    --mount "type=bind,src=$private/config,dst=/run/secrets,readonly" \
    --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/admin-password --env MYSQL_ROOT_HOST=127.0.0.1 "$prefix-server" \
    --ssl-ca=/tls/ca.crt --ssl-cert=/tls/server.crt --ssl-key=/tls/server.key \
    --require-secure-transport=ON --performance-schema-session-connect-attrs-size=2048 >/dev/null
  ready() { docker exec "$server" mysql --defaults-extra-file=/run/secrets/admin.cnf --host=127.0.0.1 -e 'SELECT 1' >/dev/null 2>&1; }
fi
for attempt in $(seq 1 120); do
  if ready; then break; fi
  if [ "$attempt" = 120 ]; then echo 'TLS server did not become ready.' >&2; exit 1; fi
  sleep 1
done
if [ "$engine" = pg ]; then
  docker exec -i "$server" psql -X -U postgres -v ON_ERROR_STOP=1 < "$private/config/roles.sql" >"$private/provision.log" 2>&1
else
  docker exec -i "$server" mysql --defaults-extra-file=/run/secrets/admin.cnf < "$private/config/roles.sql" >"$private/provision.log" 2>&1
fi
probe() {
  docker run --rm --network "$network" --read-only --tmpfs /tmp --cap-drop ALL \
    --mount "type=bind,src=$private/config,dst=/fixture,readonly" \
    --mount "type=bind,src=$private/artifacts,dst=/artifacts" \
    --entrypoint /usr/local/bin/bun "$prefix-$1" \
    /opt/comms/packages/storage/test/fixtures/remote-tls.ts "$2" "$3"
}
probe trusted seed database.test
probe trusted pass database.test
probe untrusted deny database.test
# Paired successful restores prove the same credentials/archive/target work and that denial left no table behind.
probe trusted pass database.test
probe trusted deny wrong.test
probe trusted pass database.test
echo "Real $engine pools and native dump/load verified private CA trust and hostname refusal."
