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
