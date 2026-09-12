# Sourced only by the disposable image harness; shares its exact private resources and cleanup.
bun build packages/server/test/fixtures/transfer-activation-crash.ts --target=bun --packages=external \
  --outfile "$private/activation-crash.js" >/dev/null
bun build scripts/transfer-acceptance-crash-inspect.ts --target=bun --packages=external \
  --outfile "$private/activation-inspect.js" >/dev/null
# The nonsecret test bundle must be readable by the immutable boot UID in the container.
chmod 0444 "$private/activation-crash.js" "$private/activation-inspect.js"
run_transfer transfer crash
transfer_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["transfer_id"])' "$private/transfer.json")
inspect_activation() {
  docker run --rm --network none --read-only --user 0:0 --entrypoint /usr/local/bin/bun \
    --mount "type=volume,src=$volume,dst=/data,readonly" \
    --mount "type=bind,src=$private/activation-inspect.js,dst=/opt/comms/packages/server/dist/activation-inspect.js,readonly" "$board_image" \
    /opt/comms/packages/server/dist/activation-inspect.js "$transfer_id"
}
if [ "$target_engine" = pg ]; then
  target_sql() { docker exec -i "$prefix-target-database" psql -X -U postgres -d "$1" -At -v ON_ERROR_STOP=1 2>"$private/activation-sql-private"; }
else
  target_sql() { docker exec -i "$prefix-target-database" mysql --defaults-extra-file=/run/secrets/admin.cnf --database="$1" --batch --skip-column-names 2>"$private/activation-sql-private"; }
fi
inspect_activation
# Both source stores retired, but the target's SQL completion alone must not enable startup.
[ "$(printf '%s\n' 'SELECT value FROM settings WHERE `key`='"'transfer_state'" | \
  if [ "$target_engine" = pg ]; then tr '\140' '\042' | target_sql comms_boot; else target_sql comms_boot; fi)" = complete ]
launch_board "$target_board" target
for attempt in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Running}}' "$target_board")" = true ] || break
  sleep 1
done
[ "$(docker inspect --format '{{.State.Running}}' "$target_board")" = false ]
[ "$(docker inspect --format '{{.State.ExitCode}}' "$target_board")" != 0 ]
docker logs "$target_board" > "$private/incomplete-target.errors" 2>&1
grep -q 'store_transfer_incomplete' "$private/incomplete-target.errors"
docker rm "$target_board" >/dev/null
# Alter only this disposable target's already-copied row after every owner closed.
# Hex literals preserve the exact original bytes and avoid interpolating private message text into SQL.
python3 - "$private" "$target_engine" <<'PY'
import json,pathlib,re,sys
root=pathlib.Path(sys.argv[1]); state=json.loads((root/'state.json').read_text()); row=state['message']
assert re.fullmatch('[a-zA-Z0-9_-]+',row['id']), 'Unexpected fixture message identity'
for name,body in [('tamper',row['body']+' activation-tampered'),('repair',row['body'])]:
    value=body.encode().hex()
    expression=f"convert_from(decode('{value}','hex'),'UTF8')" if sys.argv[2]=='pg' else f"CONVERT(UNHEX('{value}') USING utf8mb4)"
    (root/(name+'.sql')).write_text(f"UPDATE messages SET body={expression} WHERE id='{row['id']}';\n")
PY
target_sql comms_app < "$private/tamper.sql" >/dev/null
run_transfer transfer refused
inspect_activation
target_sql comms_app < "$private/repair.sql" >/dev/null
echo 'Instrumented activation crash and tampered-target refusal passed; resuming with the unmodified CLI.'
