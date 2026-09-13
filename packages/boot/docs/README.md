# @comms/boot

The stable host beneath the editable message board. Boot keeps authentication, source editing and recovery available when the app cannot start.

Run it through the server launcher with `bun run start` at the repository root. See the [project README](../../../README.md) for setup and [deployment guide](../../../docs/deployment.md) for container configuration.

## Recovery surfaces

- `/setup` and `/auth/login`: passkey registration and sign-in.
- `/_boot`: recovery help, independent of the app.
- `/_boot/status` and `/_boot/generations`: authenticated runtime and generation diagnostics.
- `/_boot/events`: authenticated boot lifecycle and request diagnostics.
- `/.well-known/agent.json`: the boot API manifest, including authentication requirements.

Use the [editing guide](../../server/pages/docs/editing.md) for locks, conditional file writes, reloads and source history. Source-only revert and seed reset preserve messages, pages and identities. Restoring a database is a separate, human-authorized action.

## Ownership

Boot owns the public listener, credentials, process supervision, source publication, backup/restore and the durable sequence/publication boundary. It prepares candidate generations, checks readiness and selects retained good code after failure. Product routes, UI, application event browsing and optional workflows belong to the editable app.

Keep these boundaries intact when changing boot:

- Editable code runs in child processes; boot never imports it or the server implementation.
- Recovery needs positive evidence that previous database writers have stopped. A timeout alone is not proof.
- After an accepted generation, recovery preserves the current database. Unresolved journals block conflicting changes.
- Forward verified identity to the child, never the caller's credentials. Browser mutations require the configured origin.

A complete public-page policy is bounded by the 1 MiB event-append body limit. Its atomic replacement holds the publication channel gate for one DELETE and one INSERT per 500 paths (at most 500 parameters per statement); it adds no separate page-count limit. The byte limit bounds work, not wall-clock latency.

Local development runs under one OS user. The image separates boot, app and build users; see [deployment](../../../docs/deployment.md) for its limits. [Storage](storage.md) describes capacity admission, protected artifacts and retention.

## Source map

Start with [index.ts](../src/index.ts) for wiring, [supervisor.ts](../src/supervisor.ts) for child lifetime and [application.ts](../src/application.ts) for seed and snapshot selection. Recovery changes need failure, restart and durability tests in [test/](../test/), alongside `bun run check`.
