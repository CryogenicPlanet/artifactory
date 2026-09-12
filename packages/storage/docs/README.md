# SQLite store descriptors

`src/store.ts` parses and renders a selected absolute SQLite file without opening it. `src/client.ts` supplies the existing Effect SQLite client with `disableWAL: true`; schema initialization owns journal mode. Only SQLite is supported. Remote engine URLs fail without echoing credentials.

Boot and the standalone editable server consume this package. It imports neither application nor boot code and must never enter browser source. Runtime staging includes an editable copy as an ordinary workspace, just like protocol.

`APP_STORE` selects new children. If an older image supplies only `APP_DATABASE`, the child derives and validates its file descriptor from that alias. Boot also supplies matching `APP_DATABASE` for retained generations. The privileged keeper checks both before file authorization and rewrites both after its private rehearsal copy. Descriptors do not change ownership, authoritative-store recovery, schema, or store identity.

Use `file:/absolute/path.db` with percent-encoded path segments. Authority-style `file://host/path` and triple-slash `file:///path` forms are rejected. Rendering is an Effect that validates the same strict path grammar and returns a `Redacted` value; unwrap it only at the child environment boundary. Invalid paths fail with a typed `StoreError`, and child configuration errors name the variable without exposing its value.

SQLite boot and core migration ledgers record complete named prefixes independently of editable and extension migration receipts. Adoption, schema changes and the legacy `user_version` mirror commit together; mismatched or newer histories refuse startup.
