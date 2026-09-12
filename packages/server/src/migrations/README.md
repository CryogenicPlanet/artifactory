# App migrations

Use these modules for app-wide schema changes. For an extension’s own tables, prefer `api.migrate` in its factory; see the [extension guide](../../pages/docs/extensions.md#schema-changes). This directory is copied to `app/migrations/` in the installed source.

## Add a migration

Migration ID 1 is reserved for the retired `001_webhook_subscriptions` migration; never reuse it. Existing ledger rows and subscription data stay intact. The subscriptions extension now owns its table through `api.migrate`.

Add `002_description.ts` (or `002-description.ts`) with a default-exported Effect requiring only `SqlClient`. Positive safe integer IDs run in numeric order; choose a new ID greater than every existing migration. The app-owned `migrations` table records IDs, names and timestamps. Applied IDs never rerun; keep applied files unchanged and add a forward migration. Duplicate IDs and malformed filenames fail startup. Compiled `.js`, `.mts` and `.mjs` modules are also accepted; do not ship two forms of the same ID. SQL files are not loaded. SQLite, PostgreSQL and MySQL use the configured application store.

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

Each yield executes one SQL statement. Do not submit semicolon-separated scripts, transaction-control statements or external side effects. SQLite and PostgreSQL pending migration Effects and ledger entries share one epoch-gated transaction after the candidate receives `go`, before extensions and guarded health. Failure rolls back that pending batch. MySQL DDL commits implicitly: durable migration intent marks an interrupted batch as unresolved and refuses normal startup until recovery; it does not promise transactional rollback. Rehearsal runs on a disposable online clone; failed real cutovers use boot's existing close-handle restore. The built-in historical schema bootstrap remains in `ext/core/schema.ts`; its SQLite user_version is separate from these migration IDs. Migration code can deliberately break its transaction just like arbitrary kernel code; boot recovery remains the safety net.

Migration Effects and `api.migrate` must preserve kernel identity, recovery records, idempotency receipts, migration ledgers and the protection registry. SQLite rejects changes inside its transaction. PostgreSQL compares the reserved schema and all row fingerprints before commit, including deferred constraint effects. MySQL compares before clearing its durable intent: ordinary DML rolls back on failure, but implicitly committed DDL can remain and requires recovery. Fingerprints stream the complete history without a fixed row-size budget. Application tables, including an extension’s own protected tables, can still be upgraded.

Boot creates MySQL's migration-intent table under its independent initialization journal. Missing intent state on an established store fails startup with `migration_recovery_required`; the app never recreates it. Older incomplete initialization journals with a different operation list also refuse adoption. Preserve these stores for recovery rather than deleting the evidence or retrying migrations automatically.

This checks reserved table definitions and rows through the supplied client when control returns; it does not track arbitrary function-body dependencies. Module-import side effects, separate connections, deliberate transaction escape, or deleting uncertainty evidence and crashing are outside the check. MySQL recovery still depends on boot's pre-flip backup and cutover journal; this is not a sandbox for arbitrary migration code.

## Portability advisory

Successful rehearsal records `migration.non_portable` in the `generation.rehearsed`
event when a newly applied migration never called `sql.onDialect`,
`sql.onDialectOrElse`, or a shared dialect helper through its supplied SQL client.
New plain-string `api.migrate` declarations receive the same advisory; explicit
SQLite/PostgreSQL/MySQL alternatives do not. Applied receipts and ordinary startup
remain quiet. The report retains at most 64 warning identities with an overflow count.

This is an observation, not a portability verdict: even a branch can contain
unsupported SQL, and generic SQL can work across engines without branching.
Separately acquired clients or fragments constructed outside the migration Effect
are outside the observation. Replay the complete migration ladder against the
destination engine to establish compatibility before transferring.
