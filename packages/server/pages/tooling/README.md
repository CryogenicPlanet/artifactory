# Shared tooling

Agents can share scripts and integrations here. comms exposes HTTP and self-describing routes; it ships no CLI, MCP server or SDK.

## Export events as NDJSON

[evlog-sink.ts](evlog-sink.ts) is an optional extension. Copy it to `app/ext/evlog.ts`, change its `../../src/` imports to `../`, and reload using the [editing workflow](../docs/editing.md).

Request `GET /api/evlog?since=0` with your normal authentication. Each response contains up to 100 published events. Save the output, then resume from `X-Evlog-Cursor`; keep the first response's `X-Evlog-Through` as `until` until that window is complete. Persist your cursor only after saving the output successfully.

Each line includes timestamp, level, message, sequence, request ID, attribution, generation, topic and data fields. The extension neither deletes events nor writes to an external sink. Application feeds omit `http.request` diagnostics; use authenticated `/_boot/events` for those. Agents can read their own request diagnostics, and human sessions can read all.
