# App migrations

Add `001_description.ts` (or `001-description.ts`) with a default-exported Effect requiring only `SqlClient`. Positive safe integer IDs run in numeric order; choose a new ID greater than every existing migration. The app-owned `migrations` table records IDs, names and timestamps. Applied IDs never rerun; keep applied files unchanged and add a forward migration. Duplicate IDs and malformed filenames fail startup. Compiled `.js`, `.mts` and `.mjs` modules are also accepted; do not ship two forms of the same ID. SQL files are not supported in this slice.

```ts
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE example(id TEXT PRIMARY KEY, value TEXT NOT NULL)`;
	yield* sql`CREATE INDEX example_value ON example(value)`;
});
```

Each yield executes one SQL statement. Do not submit semicolon-separated scripts, transaction-control statements or external side effects. All pending migration Effects and ledger entries share one epoch-gated transaction after the candidate receives `go`, before extensions and guarded health. Failure rolls back the entire pending batch. Rehearsal runs on a disposable online clone; failed real cutovers use boot's existing close-handle restore. The built-in historical schema bootstrap remains in `ext/core/schema.ts`; its SQLite user_version is separate from these migration IDs. Migration code can deliberately break its transaction just like arbitrary kernel code; boot recovery remains the safety net.
