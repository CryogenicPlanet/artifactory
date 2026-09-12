# Sourced only for disposable whole-table copy crash acceptance.
bun scripts/transfer-acceptance-copy-build.ts "$private/copy-crash.js"
bun build scripts/transfer-acceptance-copy-inspect.ts --target=bun --packages=external \
  --outfile "$private/copy-inspect.js" >/dev/null
chmod 0444 "$private/copy-crash.js" "$private/copy-inspect.js"
run_transfer transfer copy-crash
transfer_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["transfer_id"])' "$private/transfer.json")
inspect_partial() {
  docker run --rm --network none --read-only --tmpfs /tmp --user 0:0 --entrypoint /usr/local/bin/bun \
    --mount "type=volume,src=$volume,dst=/data,readonly" \
    --mount "type=bind,src=$private/copy-inspect.js,dst=/opt/comms/packages/server/dist/copy-inspect.js,readonly" "$board_image" \
    /opt/comms/packages/server/dist/copy-inspect.js "$transfer_id"
}
if [ "$target_engine" = pg ]; then
  partial_sql() { docker exec -i "$prefix-target-database" psql -X -U postgres -d "$1" -At -v ON_ERROR_STOP=1 2>"$private/copy-sql-private"; }
else
  partial_sql() { docker exec -i "$prefix-target-database" mysql --defaults-extra-file=/run/secrets/admin.cnf --database="$1" --batch --skip-column-names 2>"$private/copy-sql-private"; }
fi
echo "Copy crash observation: before normal resume"
source_rows=$(inspect_partial)
target_rows=$(printf '%s\n' 'SELECT COUNT(*) FROM messages' | partial_sql comms_app)
[ "$target_rows" = "$source_rows" ] && [ "$target_rows" -gt 0 ]
state=$(printf '%s\n' 'SELECT value FROM settings WHERE `key`='"'transfer_state'" | \
  if [ "$target_engine" = pg ]; then tr '\140' '\042' | partial_sql comms_boot; else partial_sql comms_boot; fi)
[ "$state" = in_progress ]
# Try exact same-ID normal resume before any source restart/write changes its manifest.
run_transfer transfer refused
echo "Copy crash observation: after refused normal resume"
[ "$(inspect_partial)" = "$source_rows" ]
[ "$(printf '%s\n' 'SELECT COUNT(*) FROM messages' | partial_sql comms_app)" = "$target_rows" ]
launch_board "$target_board" target
for attempt in $(seq 1 60); do
  [ "$(docker inspect --format '{{.State.Running}}' "$target_board")" = true ] || break
  sleep 1
done
[ "$(docker inspect --format '{{.State.Running}}' "$target_board")" = false ]
[ "$(docker inspect --format '{{.State.ExitCode}}' "$target_board")" != 0 ]
docker logs "$target_board" > "$private/partial-target.errors" 2>&1
grep -q 'store_transfer_incomplete' "$private/partial-target.errors"
docker rm "$target_board" >/dev/null
docker start "$board" >/dev/null
wait_for_board "$board"
bun scripts/transfer-acceptance-http.ts verify-restarted http://localhost:8080 "$private/state.json"
docker restart --time 30 "$board" >/dev/null
wait_for_board "$board"
bun scripts/transfer-acceptance-http.ts verify-restarted http://localhost:8080 "$private/state.json"
stop_board "$board" source-after-copy-crash
echo 'Instrumented messages-table commit crash passed: source writable, partial target retained and refused; a fresh target pair is required.'
