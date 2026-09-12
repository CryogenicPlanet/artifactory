# Migration location

Add runtime migrations to [`packages/server/src/migrations/`](../src/migrations/README.md). That directory becomes `app/migrations/` on the board and is copied into each generation.

This older scaffold directory is not loaded; placing a migration here has no effect.
