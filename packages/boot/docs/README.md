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

Local development runs under one OS user. The image separates boot, app and build users; see [deployment](../../../docs/deployment.md) for its limits. [Storage](storage.md) describes capacity admission, protected artifacts and retention.

SQLite is the default; PostgreSQL/MySQL runtime integration is wired but complete board/image acceptance remains in progress. Configure both stores together and provision the required roles using [deployment](../../../docs/deployment.md#choose-a-database) and the [operator guide](../sql/README.md). Remote recovery depends on database availability; it does not make boot independent of that server.

Remote deployments additionally launch boot beneath an immutable guardian. Its only jobs are private SQL registration, keeper admission and closure evidence. It holds the original database inspector while the boot worker runs; after a worker crash it closes that process group, waits for detached keepers' receipts, proves remote session/XA absence and releases the lifetime claim. A reserved keeper may receive a distinct never-opened receipt only when durable admission is closed and the worker group is positively gone. A definitive rejection of the inspector’s first authentication has a separate terminal receipt: the acquisition scope must close and no inspector, registration or editable process may have succeeded. Ambiguous connection failures remain unresolved. Losing the guardian itself or its database connection still refuses automatic recovery; a new connection or stale PID is not equivalent proof. These boundaries do not imply remote failover support.

## Source map

Start with [index.ts](../src/index.ts) for wiring, [supervisor.ts](../src/supervisor.ts) for child lifetime and [application.ts](../src/application.ts) for seed and snapshot selection. Recovery changes need failure, restart and durability tests in [test/](../test/), alongside `bun run check`.
