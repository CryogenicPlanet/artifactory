#!/bin/sh
# Image-build only. Oracle's Debian repository currently publishes amd64 clients.
set -eu
if [ "$(dpkg --print-architecture)" != amd64 ]; then
    echo 'Native database clients require linux/amd64; Oracle MySQL 8.4 Debian arm64 packages are unavailable.' >&2
    exit 1
fi
. /etc/os-release
test "$VERSION_CODENAME" = trixie
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
mkdir -p /usr/share/keyrings
curl --fail --location --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/comms-pgdg.asc
curl --fail --location --silent --show-error https://repo.mysql.com/RPM-GPG-KEY-mysql-2025 -o /usr/share/keyrings/comms-mysql.asc
sha256sum --check <<'HASHES'
0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  /usr/share/keyrings/comms-pgdg.asc
a4bcd9f16a53cc763f87b9955dbcdced33c7aa90296b157eb6ceef0f156f4327  /usr/share/keyrings/comms-mysql.asc
HASHES
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/comms-pgdg.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main' > /etc/apt/sources.list.d/comms-pgdg.list
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/comms-mysql.asc] https://repo.mysql.com/apt/debian trixie mysql-8.4-lts' > /etc/apt/sources.list.d/comms-mysql.list
apt-get update
mkdir -m 0755 /tmp/comms-database-packages
cd /tmp/comms-database-packages
apt-get download postgresql-client-17=17.11-1.pgdg13+2 \
    mysql-common=8.4.11-1debian13 mysql-community-client=8.4.11-1debian13 \
    mysql-community-client-core=8.4.11-1debian13 mysql-community-client-plugins=8.4.11-1debian13
sha256sum --check <<'HASHES'
c36408bb62178bc9193c113da65e30fc6a5237648de5e9db1ea594214df9ae4b  postgresql-client-17_17.11-1.pgdg13+2_amd64.deb
a321addf702d21692b855878882154b1195bdbc70ba516ae86a763a091baca0f  mysql-common_8.4.11-1debian13_amd64.deb
880f6ee38a8dfc0dde7eb057616e4efb93bdd3b91e586feda7684a59afa46b9e  mysql-community-client_8.4.11-1debian13_amd64.deb
0a2294c0585d9b09c6595041bfc66eda74487fcdb93e873a934a818c700b5852  mysql-community-client-core_8.4.11-1debian13_amd64.deb
de5a20c7b143dfdca0f2578e6ddc852815908ac657921abf091f37b2f8421818  mysql-community-client-plugins_8.4.11-1debian13_amd64.deb
HASHES
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ./*.deb
cd /
rm -rf /tmp/comms-database-packages /var/lib/apt/lists/*
