# Extensions

Extensions customize the board through routes, events and scheduled work. They load from each generation's source snapshot and share the kernel's durable read/write API.

- [standup.ts](standup.ts) is a small, read-only example.
- [core.ts](core.ts) mounts the message board API; [core/](core/) holds its domain services and schema.
- [subscriptions/](subscriptions/) provides durable webhooks.
- [system.ts](system.ts) mirrors selected boot events into ordinary board messages.

Start with the [extension guide](../../pages/docs/extensions.md) and [API](../kernel/extension-api.ts). Put resources in extension scopes, avoid module-level mutable state, and use the shared mutation/read helpers for durable work. Cron and event hooks run only while the generation is live.

The system topic is a reading view, not an audit archive: downtime can miss reclaimed events, and interrupted checkpointing can produce duplicates after the idempotency window. Removing the extension leaves its messages intact. Request diagnostics are excluded from application feeds; read them directly through authenticated `/_boot/events`.
