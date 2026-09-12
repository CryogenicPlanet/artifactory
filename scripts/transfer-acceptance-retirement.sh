# Sourced only for disposable first-retirement commit crash acceptance.
bun scripts/transfer-acceptance-retirement-build.ts "$private/retirement-crash.js"
bun build scripts/transfer-acceptance-retirement-inspect.ts --target=bun --packages=external \
  --outfile "$private/retirement-inspect.js" >/dev/null
chmod 0444 "$private/retirement-crash.js" "$private/retirement-inspect.js"
run_transfer transfer retirement-crash
transfer_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["transfer_id"])' "$private/transfer.json")
docker run --rm --network none --read-only --user 0:0 --entrypoint /usr/local/bin/bun \
  --mount "type=volume,src=$volume,dst=/data,readonly" \
  --mount "type=bind,src=$private/retirement-inspect.js,dst=/opt/comms/packages/server/dist/retirement-inspect.js,readonly" "$board_image" \
  /opt/comms/packages/server/dist/retirement-inspect.js "$transfer_id"
if [ "$target_engine" = pg ]; then
  retirement_sql() { docker exec -i "$prefix-target-database" psql -X -U postgres -d comms_boot -At -v ON_ERROR_STOP=1 2>"$private/retirement-sql-private"; }
else
  retirement_sql() { docker exec -i "$prefix-target-database" mysql --defaults-extra-file=/run/secrets/admin.cnf --database=comms_boot --batch --skip-column-names 2>"$private/retirement-sql-private"; }
fi
printf '%s\n' 'SELECT value FROM settings WHERE `key`='"'transfer_journal'" | \
  if [ "$target_engine" = pg ]; then tr '\140' '\042' | retirement_sql; else retirement_sql; fi \
  > "$private/retirement-journal.json"
python3 - "$private/retirement-journal.json" "$transfer_id" <<'PY'
import json,sys
journal=json.load(open(sys.argv[1]))
assert journal['phase']=='verified', 'Target phase advanced past first retirement commit'
assert journal['binding']['transfer_id']==sys.argv[2], 'Target binding changed'
PY
state=$(printf '%s\n' 'SELECT value FROM settings WHERE `key`='"'transfer_state'" | \
  if [ "$target_engine" = pg ]; then tr '\140' '\042' | retirement_sql; else retirement_sql; fi)
[ "$state" = in_progress ]
echo 'Instrumented first retirement commit crash passed; completing with the unmodified CLI and same binding.'
