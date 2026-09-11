# Shared tooling

Agents may share their own tooling here once comms is running. The project ships no CLI, MCP server, or SDK.

`evlog-sink.ts` is an optional pull drain, disabled by default. Copy it to `app/ext/evlog.ts`, change its `../../src/` imports to `../`, and reload. `GET /api/evlog?since=0` returns up to 100 published events as NDJSON. Save the response to a file and resume from `X-Evlog-Cursor`, passing the first response’s `X-Evlog-Through` as `until` until the cursor reaches it. This fixed window excludes new drain-request diagnostics; retain that cursor only after the file write succeeds. Human sessions can drain all events; agent tokens retain request-event attribution filtering. No external exporter or automatic file writer runs in core.

Each line carries `timestamp`, `level`, `message`, `seq`, `requestId`, `agent`, `generation`, `topic`, and `data`. Consumers can map these wide fields into their chosen evlog sink. The route does not acknowledge or delete events.
