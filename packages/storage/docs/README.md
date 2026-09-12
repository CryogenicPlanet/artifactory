# SQLite store descriptors

`src/store.ts` parses and renders a selected absolute SQLite file without opening it. `src/client.ts` supplies the existing Effect SQLite client with `disableWAL: true`; schema initialization owns journal mode. Only SQLite is supported. Remote engine URLs fail without echoing credentials.

Boot and the standalone editable server consume this package. It imports neither application nor boot code and must never enter browser source. Runtime staging includes an editable copy as an ordinary workspace, just like protocol.

`APP_STORE` selects new children. If an older image supplies only `APP_DATABASE`, the child derives and validates its file descriptor from that alias. Boot also supplies matching `APP_DATABASE` for retained generations. The privileged keeper checks both before file authorization and rewrites both after its private rehearsal copy. Descriptors do not change ownership, authoritative-store recovery, schema, or store identity.

Use `file:/absolute/path.db` with percent-encoded path segments. Authority-style `file://host/path` and triple-slash `file:///path` forms are rejected. Rendering is an Effect that validates the same strict path grammar and returns a `Redacted` value; unwrap it only at the child environment boundary. Invalid paths fail with a typed `StoreError`, and child configuration errors name the variable without exposing its value.

## Isolated remote session clients

The experimental `remote-client`, `remote-inspector`, and `remote-session` exports are not wired to boot, descriptors, migrations, or the board. They do not add PostgreSQL/MySQL backend support. Exact Effect drivers use explicit connection fields and redacted passwords; failures discard driver causes and credentials.

Construct the inspector scope before the client and provide its service to the client layer. Every physical lease must receive a durable registration acknowledgement before application SQL, including transactions, streams, and explicit reservation. The callback must use independent storage or IPC, never this pool. The inspector checks the same pinned connection before acknowledging registration. Failed registration releases its lease; the patched MySQL driver also owns its pool before its initial connectivity query can fail.

`assertNoSessions` closes further registration admission, awaits the caller's positive local-writer closure, and checks for the exact attempt tag and every registered connection ID through the still-pinned inspector. PostgreSQL metadata references use `pg_catalog` explicitly. Reused IDs conservatively prevent acceptance. Missing/truncated MySQL attributes, lost inspector connections, and changed server identity fail closed. Other attempt tags are left alone. No connection is killed. Attempt tags are 32 random bytes supplied as 64 hexadecimal characters and encoded for the handshake.

This observes session absence on one continuously observed authoritative server. It does not prove restart recovery, HA fencing, absence of delayed authentication handshakes, or absence of prepared transactions. PostgreSQL connections require `max_prepared_transactions=0`. MySQL prepared XA transactions remain an integration blocker; no XA administration privilege is granted here. Editable SQL that opens unregistered connections is outside this building block's contract. Session inspection requires the app account's SELECT access to `performance_schema.session_account_connect_attrs` on MySQL, without global PROCESS or CONNECTION_ADMIN.

`bash scripts/remote-session-acceptance.sh pg` and `... mysql` use disposable digest-pinned containers and protected credential files. The separate CI workflow also verifies MySQL instrumentation truncation. These tests are explicitly gated and do not run containers during the default SQLite suite.

Each pool owns its PostgreSQL integer codec; BIGINT values must fit JavaScript safe integers. MySQL keeps unsafe BIGINT results lossless until the guarded connection rejects them. Text and JSON strings are not treated as numbers. Query errors retain only unique-conflict, deadlock and serialization categories; driver causes, messages and constraint names are discarded.

SQLite boot and core migration ledgers record complete named prefixes independently of editable and extension migration receipts. Adoption, schema changes and the legacy `user_version` mirror commit together; mismatched or newer histories refuse startup.
