# @comms/storage

Shared database mechanisms for immutable boot and the standalone editable server: store descriptors, Effect SQL clients, dialect fragments, migration ledgers and remote connection ownership. This package imports neither boot nor application code and never enters browser source. Runtime staging copies it as an editable workspace alongside protocol.

SQLite is the default. PostgreSQL and Oracle MySQL drivers are wired into the current runtime integration; complete board and image acceptance remains in progress. See [deployment](../../../docs/deployment.md) for configuration and [operator provisioning](../../boot/sql/README.md) for database roles. Passing client tests alone does not establish restart, restore or engine-transfer support.

## Stores and queries

Start with [store.ts](../src/store.ts), [dialect.ts](../src/dialect.ts) and [remote-client.ts](../src/remote-client.ts).

- Descriptors select a store; parsing never opens it, creates it or establishes its identity. SQLite uses `file:/absolute/path.db` with percent-encoded segments; `file://` forms are rejected. Remote descriptors use `postgres://` or `mysql://`, with encoded credentials and one database path, without query options or fragments.
- `render` returns an Effect that validates descriptors and produces a `Redacted` value; invalid input fails with a typed error without exposing its value. Child configuration errors identify the variable. Unwrap only at a required connection/environment boundary. Boot credentials must never reach editable children. The SQLite-only `parse` and `childStore` exports retain the file/`APP_DATABASE` compatibility contract, including alias-only startup for older images; remote callers use `parseDescriptor`.
- Own each client in a scope. PostgreSQL integer and raw JSON decoding is pool-local; unsafe integers fail instead of losing precision. MySQL preserves large integers until checked decoding. Driver errors expose safe categories, not credentials, connection URLs or driver causes.
- Keep boot, core, editable and extension migration histories separate. SQLite’s validated named ledger is authoritative. Adoption, pending DDL, receipts and the derived `user_version` mirror commit together; a lagging mirror repairs forward without replaying recorded steps, and unchanged mirrors are not rewritten. A mirror ahead of the ledger, corrupt IDs or names, and newer histories refuse startup with bounded diagnostics. Initial adoption uses the mirror only when no ledger exists. MySQL DDL needs durable step intent and postcondition recovery because its DDL commits implicitly.

## Remote ownership

Editable leases use `guardianClientLayer`: a physical connection cannot execute app SQL until the immutable guardian acknowledges its durable registration over private IPC. The callback must use independent storage or IPC, never the pool being registered. This applies to transactions, streams and explicit leases too. MySQL checks `REPEATABLE-READ` isolation on each leased connection before registration; other levels fail with `remote_isolation_unsupported`. Admission does not change operator settings.

The pinned PostgreSQL/MySQL driver patches discard a lease whose scope exits with failure before returning it to the pool. This includes failed outer transaction COMMIT/ROLLBACK, so a queued borrower cannot inherit that uncertain session while application failure handling runs. Ordinary failed transactions may also lose their connection after successful rollback. The shared Effect transaction patch remembers failed transaction controls across nested calls: catching a failed savepoint boundary cannot make the outer transaction commit. Ordinary caught body failures remain valid when their savepoint rollback succeeds. The existing read/mutation gate remains in place.

`remoteOwnerInspectorLayer` keeps inspection connections pinned for the owner's lifetime. Closing an account requires closed registration admission, positive local process/keeper closure, absence of all sessions for that login (including untagged sessions), and no surviving prepared work. It never kills arbitrary sessions or rolls back unknown transactions. PostgreSQL requires `max_prepared_transactions=0`; MySQL requires session-attribute inspection and boot-only `XA_RECOVER_ADMIN`, as described in the operator guide.

The boot guardian survives a boot-worker crash and writes closure receipts only after these checks. Lost guardian/inspector continuity, truncated instrumentation, mismatched identity or missing receipts cause refusal. Reconnecting to a server or observing a stale PID is not closure proof. HA/failover and deliberately adversarial clients are not covered.

## Validation

Run `bun run check` and focused storage tests after changes. [Remote client acceptance](../../../scripts/remote-session-acceptance.sh) uses disposable pinned database containers; [real-board acceptance](../../../scripts/remote-board-acceptance.sh) exercises the image separately. Neither runs in the default SQLite suite. Check [current acceptance](../../../docs/build-plan.md) before treating a workflow or a prepared integration as verified behavior.

[Private CA acceptance](../../../scripts/remote-tls-acceptance.sh) runs the built image against disposable TLS servers. It checks encrypted guarded queries and real native dump/load with a trusted CA, then requires refusal with an unrelated CA or a mismatched hostname. This is a separate Linux image check; preparing the fixture or passing argument tests does not prove a successful TLS handshake.
