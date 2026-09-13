import assert from "node:assert/strict";
import { Cause, Effect, Exit, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clientLayer } from "../../src/client.ts";
import { migrate } from "../../src/migrations.ts";

const filename = process.argv[2];
const mode = process.argv[3];
const ledger = Schema.decodeUnknownSync(Schema.Literals(["boot_migrations", "core_migrations"]))(process.argv[4]);
assert(filename);
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const snapshot = () =>
			Effect.gen(function* () {
				const schema = yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY name`;
				const version = yield* sql`PRAGMA user_version`;
				const data = yield* sql`SELECT * FROM preserved ORDER BY kind`;
				const editable = yield* sql`SELECT * FROM migrations`;
				const extensions = yield* sql`SELECT * FROM extension_migrations`;
				const tables = yield* sql`SELECT name FROM sqlite_master WHERE name=${ledger}`;
				const receipts = tables.length
					? yield* sql`SELECT migration_id,name FROM ${sql(ledger)} ORDER BY migration_id`.pipe(
							Effect.orElseSucceed(() => []),
						)
					: [];
				return { schema, version, data, editable, extensions, receipts };
			});
		const initialize = (failure = false, pause = false, future = false) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* migrate(sql, ledger, [
						{ id: 1, name: "preserved", run: Effect.die("Legacy migration must never rerun") },
						{
							id: 2,
							name: "addition",
							run: Effect.gen(function* () {
								yield* sql`CREATE TABLE addition(value TEXT NOT NULL)`;
								yield* sql`INSERT INTO addition VALUES ('new')`;
							}),
						},
						{
							id: 3,
							name: "completion",
							run: Effect.gen(function* () {
								yield* sql`ALTER TABLE preserved ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1`;
								if (failure) return yield* Effect.fail(new Error("injected migration failure"));
							}),
						},
						...(future
							? [{ id: 4, name: "future", run: sql`CREATE TABLE future(value TEXT)`.pipe(Effect.asVoid) }]
							: []),
					]);
					if (pause) {
						yield* Effect.sync(() => process.stdout.write("READY\n"));
						return yield* Effect.never;
					}
				}),
			);
		if (mode === "seed") {
			yield* sql`PRAGMA journal_mode=WAL`;
			yield* sql`PRAGMA synchronous=FULL`;
			yield* sql`CREATE TABLE preserved(kind TEXT PRIMARY KEY, value TEXT NOT NULL)`;
			for (const kind of ["messages", "pages", "identities"])
				yield* sql`INSERT INTO preserved VALUES (${kind},'retained')`;
			yield* sql`CREATE TABLE migrations(migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
			yield* sql`INSERT INTO migrations VALUES(1,'editable')`;
			yield* sql`CREATE TABLE extension_migrations(extension TEXT, name TEXT, checksum TEXT)`;
			yield* sql`INSERT INTO extension_migrations VALUES('example','001','checksum')`;
			yield* sql`PRAGMA user_version=1`;
		} else if (mode === "snapshot") {
			process.stdout.write(JSON.stringify(yield* snapshot()));
		} else if (mode === "crash") {
			yield* initialize(false, true);
		} else if (mode === "ahead" || mode === "future") {
			yield* initialize();
			const before = yield* snapshot();
			yield* sql`PRAGMA user_version=1`;
			yield* initialize();
			assert.deepEqual(yield* snapshot(), before);
			if (mode === "future") {
				yield* initialize(false, false, true);
				assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 4 }]);
				assert.deepEqual(yield* sql`SELECT migration_id,name FROM ${sql(ledger)} WHERE migration_id=4`, [
					{ migration_id: 4, name: "future" },
				]);
				const after = yield* snapshot();
				yield* initialize(false, false, true);
				assert.deepEqual(yield* snapshot(), after);
			}
		} else if (mode === "steps") {
			const before = yield* snapshot();
			const result = yield* migrate(sql, ledger, [{ id: 2, name: "bad", run: Effect.void }]).pipe(Effect.result);
			assert.equal(result._tag, "Failure");
			if (result._tag === "Failure") assert.match(String(result.failure), /migration_steps_invalid at 1/);
			assert.deepEqual(yield* snapshot(), before);
		} else if (mode === "success" || mode === "failure") {
			const before = yield* snapshot();
			if (mode === "failure") {
				const failed = yield* Effect.exit(initialize(true));
				assert(Exit.isFailure(failed));
				assert.match(Cause.pretty(failed.cause), /injected migration failure/);
				assert.deepEqual(yield* snapshot(), before);
			}
			yield* initialize();
			const after = yield* snapshot();
			assert.deepEqual(after.version, [{ user_version: 3 }]);
			assert.deepEqual(after.receipts, [
				{ migration_id: 1, name: "preserved" },
				{ migration_id: 2, name: "addition" },
				{ migration_id: 3, name: "completion" },
			]);
			assert.deepEqual(
				after.data,
				["identities", "messages", "pages"].map((kind) => ({ kind, value: "retained", migrated: 1 })),
			);
			assert.deepEqual(after.editable, before.editable);
			assert.deepEqual(after.extensions, before.extensions);
			yield* initialize();
			assert.deepEqual(yield* snapshot(), after);
		} else {
			if (mode === "invalid-mirror") yield* sql`PRAGMA user_version=-1`;
			else if (mode === "newer-version") yield* sql`PRAGMA user_version=4`;
			else if (mode === "object")
				yield* sql`CREATE VIEW ${sql(ledger)} AS SELECT 1 AS migration_id,'preserved' AS name`;
			else if (mode === "shape") yield* sql`CREATE TABLE ${sql(ledger)}(wrong_column TEXT)`;
			else {
				yield* sql`CREATE TABLE ${sql(ledger)}(migration_id INTEGER PRIMARY KEY,name TEXT)`;
				if (mode === "gap") yield* sql`INSERT INTO ${sql(ledger)} VALUES(2,'addition')`;
				else if (mode === "wrong-name") yield* sql`INSERT INTO ${sql(ledger)} VALUES(1,'DO_NOT_LOG_LEDGER_NAME')`;
				else if (mode === "mirror") {
					yield* sql`INSERT INTO ${sql(ledger)} VALUES(1,'preserved')`;
					yield* sql`PRAGMA user_version=2`;
				} else if (mode === "newer-ledger") yield* sql`INSERT INTO ${sql(ledger)} VALUES(4,'future')`;
				else if (mode !== "empty") throw new Error(`Unknown mode ${mode}`);
			}
			const before = yield* snapshot();
			const failed = yield* Effect.exit(initialize());
			assert(Exit.isFailure(failed));
			const expected =
				mode === "invalid-mirror"
					? "migration_mirror_invalid"
					: mode === "gap"
						? "migration_ledger_id_invalid"
						: mode === "wrong-name"
							? "migration_ledger_name_mismatch"
							: mode === "mirror" || mode === "empty"
								? "migration_mirror_ahead"
								: mode === "object"
									? "migration_ledger_object_invalid"
									: mode === "shape"
										? "migration_ledger_shape_invalid"
										: "migration_ledger_too_new";
			assert.match(Cause.pretty(failed.cause), new RegExp(expected));
			assert(!Cause.pretty(failed.cause).includes("DO_NOT_LOG_LEDGER_NAME"));
			assert.deepEqual(yield* snapshot(), before);
		}
	}).pipe(Effect.provide(clientLayer({ _tag: "file", filename }))),
);
