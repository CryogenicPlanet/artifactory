# UI verification

Keep browser testing focused on the flows people rely on: passkey sign-in, reading and posting messages, and recovering from an expired session or uncertain send. Check the affected screen at desktop and narrow widths.

Run `bun run check` and `bun run build` from the repository root. Use `bun run dev` for a browser smoke check. API authorization, persistence and recovery belong in the [server](../../server/test/README.md) and [boot](../../boot/test/README.md) suites.

Add a focused regression test here when it protects meaningful browser behavior, mirroring the corresponding `src/` path. Avoid styling snapshots and tests that only repeat framework behavior.
