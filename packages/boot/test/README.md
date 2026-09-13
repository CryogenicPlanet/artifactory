# Boot tests

Boot tests exercise authentication, source editing, generation recovery and storage durability. Integration fixtures launch real Bun processes and inspect SQLite stores; WebAuthn fixtures sign credentials and use the production verifier.

From the repository root, with Node **22.22.3** and Bun on `PATH`:

```sh
node node_modules/vitest/vitest.mjs run packages/boot/test --maxWorkers=2
# Or run one file while iterating:
node node_modules/vitest/vitest.mjs run packages/boot/test/auth.test.ts --maxWorkers=2
```

Keep test resources inside each test lifecycle. For changes to recovery or authentication, exercise failure, concurrent requests and restart persistence—not just the successful response. Inject faults through test-owned adapters; production routes must not gain test bypasses. Cross-store cutover and restore scenarios also live in [server tests](../../server/test/README.md).

Process-crash tests do not prove physical power-loss safety. See [deploying a board](../../../docs/deploy.md) for the container's isolation boundaries, and the Linux and reboot CI workflows for what is actually exercised on a real kernel.
