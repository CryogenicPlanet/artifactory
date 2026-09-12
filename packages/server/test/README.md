# Server tests

These tests exercise the message board through real HTTP, Bun child processes and SQLite stores, with focused kernel tests for transactions, publication and recovery.

From the repository root, with Node **22.22.3** and Bun on `PATH`:

```sh
node node_modules/vitest/vitest.mjs run packages/server/test --maxWorkers=2
# Or focus on the area you changed:
node node_modules/vitest/vitest.mjs run packages/server/test/pages-http.test.ts --maxWorkers=2
```

For write-path changes, check authorization, idempotent retries, publication visibility and restart persistence. Recovery changes need real-process cutover or restore tests that verify acknowledged data survives. Kernel readiness tests exercise mutation, publication-aware reads and rollback; readiness alone does not validate every product route.

Fixtures may import boot internals to test the cross-store boundary. Keep fault injection and synthetic credentials in fixtures, own resources within each test lifecycle, and clean up child processes. See [boot tests](../../boot/test/README.md) for the complementary authentication and recovery suites.

## Shared store behavior

One fixture runs the same dialect, transaction rollback, topic-move cursor,
repeatable-read and publication-fenced previous-image assertions on SQLite,
PostgreSQL and MySQL:

```sh
node node_modules/vitest/vitest.mjs run packages/server/test/kernel/remote-dialect-semantics.test.ts --maxWorkers=1
COMMS_TEST_ENGINE=pg COMMS_TEST_STORE_CONFIG=/private/pg-fixture.json \
  node node_modules/vitest/vitest.mjs run packages/server/test/kernel/remote-dialect-semantics.test.ts --maxWorkers=1
```

The default is scoped in-memory SQLite, a test facility rather than a deployment
store descriptor. For `pg` or `mysql`, supply a protected JSON configuration with
`engine`, `host`, `port`, `database`, `username` and `password`. The database must be
an exclusively allocated, empty `comms_shared_store`; the fixture refuses existing
tables and removes only its declared tables when its scope closes. Never point it
at a board database. `scripts/remote-session-acceptance.sh` provisions this isolated
store and runs the same group on real PostgreSQL and MySQL in Linux CI.

This is a shared behavior group, not full-suite engine parity. Physical SQLite
file/WAL and fault-injection tests remain SQLite-specific; publication delivery,
keeper closure and complete board recovery have separate acceptance suites.
