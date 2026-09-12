# App migrations

Use these modules for app-wide schema changes. For an extension’s own tables, prefer `api.migrate` in its factory; see the [extension guide](../../pages/docs/extensions.md#schema-changes). This directory is copied to `app/migrations/` in the installed source.

## Add a migration

Migration ID 1 is reserved for the retired `001_webhook_subscriptions` migration; never reuse it. Existing ledger rows and subscription data stay intact. The subscriptions extension now owns its table through `api.migrate`.

Add `002_description.ts` (or `002-description.ts`) with a default-exported Effect requiring only `SqlClient`. Positive safe integer IDs run in numeric order; choose a new ID greater than every existing migration. The app-owned `migrations` table records IDs, names and timestamps. Applied IDs never rerun; keep applied files unchanged and add a forward migration. Duplicate IDs and malformed filenames fail startup. Compiled `.js`, `.mts` and `.mjs` modules are also accepted; do not ship two forms of the same ID. SQL files are not loaded. This branch uses SQLite.

```ts
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE example(id TEXT PRIMARY KEY, value TEXT NOT NULL)`;
	yield* sql`CREATE INDEX example_value ON example(value)`;
});
```

## Execution and recovery

Each yield executes one SQL statement. Do not submit semicolon-separated scripts, transaction-control statements or external side effects. All pending migration Effects and ledger entries share one epoch-gated transaction after the candidate receives `go`, before extensions and guarded health. Failure rolls back the entire pending batch. Rehearsal runs on a disposable online clone; failed real cutovers use boot's existing close-handle restore. The built-in historical schema bootstrap remains in `ext/core/schema.ts`; its SQLite user_version is separate from these migration IDs. Migration code can deliberately break its transaction just like arbitrary kernel code; boot recovery remains the safety net.

Migration Effects and `api.migrate` cannot change kernel identity, recovery records, idempotency receipts, migration ledgers or the protection registry. SQLite checks these inside the migration transaction and rolls back forbidden schema changes, including temporary objects that shadow kernel tables. Application tables, including an extension’s own protected tables, can still be upgraded. This guards SQL run through the supplied client; module-import side effects, separate connections and deliberate transaction escape are outside it.
