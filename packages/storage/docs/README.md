# SQLite store descriptors

`src/store.ts` parses and renders a selected absolute SQLite file without opening it. `src/client.ts` supplies the existing Effect SQLite client with `disableWAL: true`; schema initialization owns journal mode. Only SQLite is supported. Remote engine URLs fail without echoing credentials.

Boot and the standalone editable server consume this package. It imports neither application nor boot code and must never enter browser source. Runtime staging includes an editable copy as an ordinary workspace, just like protocol.

`APP_STORE` selects new children. If an older image supplies only `APP_DATABASE`, the child derives and validates its file descriptor from that alias. Boot also supplies matching `APP_DATABASE` for retained generations. The privileged keeper checks both before file authorization and rewrites both after its private rehearsal copy. Descriptors do not change ownership, authoritative-store recovery, schema, or store identity.

Use `file:/absolute/path.db` with percent-encoded path segments. Authority-style `file://host/path` and triple-slash `file:///path` forms are rejected. Rendering is an Effect that validates the same strict path grammar and returns a `Redacted` value; unwrap it only at the child environment boundary. Invalid paths fail with a typed `StoreError`, and child configuration errors name the variable without exposing its value.

## Credential boundaries deferred to remote runtime

This SQLite-only layer does not secure remote credentials at these later process boundaries:

- Launcher to child: `APP_DATABASE` is plaintext in the child environment and is read with `Config.String`.
- Server to SQL read worker: `BootChannel` exposes a filename, rebuilt as a store selection and JSON-encoded into the worker’s stdin. A remote URL must remain protected through that transport.
- Supervisor to privileged keeper: the environment map is JSON-encoded in `COMMS_CHILD_CONFIG`. Decode failures can reach keeper stderr and the retained generation stderr tail; the existing hexadecimal redactor does not scrub connection URLs.

Remote runtime must address each boundary before accepting credential-bearing descriptors. Parser errors naming variables without values do not establish transport or stderr redaction.
