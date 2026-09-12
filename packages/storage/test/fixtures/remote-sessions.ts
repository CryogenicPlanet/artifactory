import { appendFile, open as openFile, readFile, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Redacted, Ref, Schema, Scope, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "../../src/remote-client.ts";
import { remoteInspectorLayer, RemoteInspector } from "../../src/remote-inspector.ts";
import { type RemoteConnection, type RemoteSession, attemptTag } from "../../src/remote-session.ts";
import { readTransaction } from "../../src/dialect.ts";
import { open, sessions } from "../../src/remote-driver.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});

async function main() {
	const filename = process.env.COMMS_REMOTE_TEST_CONFIG;
	const journal = process.env.COMMS_REMOTE_TEST_JOURNAL;
	const mode = process.env.COMMS_REMOTE_TEST_MODE;
	if (!filename || !journal || !mode) throw new Error("Missing disposable fixture configuration");
	const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
	const connection: RemoteConnection = { ...settings, password: Redacted.make(settings.password), tls: false };
	let phase = "start";
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const attempt = "a1".repeat(32);
				if (mode === "missing" || mode === "prepared") {
					let selected = connection;
					if (mode === "prepared") {
						phase = "prepared_restart";
						yield* Effect.promise(() => writeFile(`${journal}.restart`, "ready"));
						let resumed = false;
						for (let index = 0; index < 300; index++) {
							resumed = yield* Effect.promise(() =>
								readFile(`${journal}.restarted`, "utf8").then(
									() => true,
									() => false,
								),
							);
							if (resumed) break;
							yield* Effect.sleep("100 millis");
						}
						assert(resumed);
						const port = Number(yield* Effect.promise(() => readFile(`${journal}.restarted`, "utf8")));
						assert(Number.isInteger(port) && port > 0 && port <= 65535);
						process.stdout.write(JSON.stringify({ publishedPortChanged: port !== connection.port }));
						// Docker may allocate a new random host port at restart. Only this fresh observer follows it;
						// the restart case keeps its original pinned inspector and must still refuse closure.
						selected = { ...connection, port };
					}
					phase = "configuration_observer";
					const observer = yield* open(selected, "fixture-observer");
					phase = "configuration_query";
					const setting = yield* observer.unsafe<{ readonly configured: string | number }>(
						mode === "prepared"
							? "SELECT current_setting('max_prepared_transactions') AS configured"
							: "SELECT @@performance_schema_session_connect_attrs_size AS configured",
					);
					phase = `configuration_value_${String(setting[0]?.configured)}`;
					assert.equal(String(setting[0]?.configured), mode === "prepared" ? "10" : "32");
					phase = "configuration_refusal";
					assert(
						Exit.isFailure(
							yield* Layer.build(remoteInspectorLayer({ connection: selected, attempt })).pipe(Effect.exit),
						),
					);
					return;
				}
				phase = "inspector";
				const inspector = Context.get(
					yield* Layer.build(remoteInspectorLayer({ connection, attempt })),
					RemoteInspector,
				);
				const registered = yield* Ref.make<ReadonlyArray<RemoteSession>>([]);
				const allow = yield* Ref.make(mode !== "reject" && mode !== "pending");
				const entered = yield* Deferred.make<void>();
				const acknowledge = yield* Deferred.make<void>();
				const child = yield* Scope.make();
				yield* Effect.addFinalizer((exit) => Scope.close(child, exit));
				const register = (session: RemoteSession) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined);
						if (mode === "pending") yield* Deferred.await(acknowledge);
						if (!(yield* Ref.get(allow))) return yield* Effect.fail(new Error(settings.password));
						yield* Effect.promise(async () => {
							await appendFile(journal, `${JSON.stringify(session)}\n`, { mode: 0o600 });
							const file = await openFile(journal, "r+");
							try {
								await file.sync();
							} finally {
								await file.close();
							}
						});
						yield* Ref.update(registered, (rows) => [...rows, session]);
					});
				phase = "guarded_client";
				const context = yield* Scope.provide(
					Layer.build(
						remoteClientLayer({ connection, attempt, register }).pipe(
							Layer.provide(Layer.succeed(RemoteInspector, inspector)),
						),
					),
					child,
				);
				const sql = Context.get(context, SqlClient);
				if (mode === "isolation") {
					assert.equal(connection.engine, "mysql");
					const observer = yield* (yield* open(connection, "fixture-observer")).reserve;
					const tag = yield* attemptTag({ connection, attempt });
					phase = "default_isolation";
					assert.deepEqual(yield* readTransaction(sql, sql`SELECT 1 AS accepted`), [{ accepted: 1 }]);
					phase = "change_all_physical_leases";
					const leases = yield* Effect.forEach([0, 1, 2, 3], () =>
						Effect.gen(function* () {
							const lease = yield* Scope.make();
							yield* Effect.addFinalizer((exit) => Scope.close(lease, exit));
							const reserved = yield* Scope.provide(sql.reserve, lease);
							yield* reserved.executeUnprepared(
								"SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
								[],
								undefined,
							);
							return lease;
						}),
					);
					const tainted = new Set((yield* Ref.get(registered)).map((session) => session.connectionId));
					assert.equal(tainted.size, 4);
					assert.deepEqual(
						new Set(yield* sessions(observer, "mysql", tag).pipe(Effect.map((rows) => rows.map(([id]) => id)))),
						tainted,
					);
					for (const lease of leases) yield* Scope.close(lease, Exit.void);
					const registrations = (yield* Ref.get(registered)).length;
					const entered = yield* Ref.make(false);
					phase = "reject_changed_isolation";
					// Each rejected physical lease must disappear before a fresh default-isolation lease can enter.
					let remaining = tainted;
					for (let index = 0; index < tainted.size; index++) {
						phase = `reject_changed_isolation_${index}`;
						const denied = yield* readTransaction(sql, Ref.set(entered, true).pipe(Effect.andThen(sql`SELECT 1`))).pipe(
							Effect.exit,
						);
						assert(Exit.isFailure(denied));
						assert(JSON.stringify(denied).includes("remote_isolation_unsupported"));
						assert(!JSON.stringify(denied).includes(settings.password));
						let current = remaining;
						for (let poll = 0; poll < 100; poll++) {
							current = new Set(
								yield* sessions(observer, "mysql", tag).pipe(Effect.map((rows) => rows.map(([id]) => id))),
							);
							if (current.size === remaining.size - 1) break;
							yield* Effect.sleep("50 millis");
						}
						assert.equal(current.size, remaining.size - 1);
						assert([...current].every((id) => remaining.has(id)));
						remaining = current;
					}
					assert.equal(yield* Ref.get(entered), false);
					assert.equal((yield* Ref.get(registered)).length, registrations);
					phase = "replacement_default_isolation";
					const replacement = yield* readTransaction(
						sql,
						Ref.set(entered, true).pipe(
							Effect.andThen(sql<{ readonly id: string; readonly isolation: string }>`
								SELECT CAST(CONNECTION_ID() AS CHAR) AS id, @@SESSION.transaction_isolation AS isolation
							`),
						),
					);
					assert.equal(yield* Ref.get(entered), true);
					assert.equal(replacement.length, 1);
					assert.equal(replacement[0]?.isolation, "REPEATABLE-READ");
					const replacementId = replacement[0]?.id;
					assert(replacementId && !tainted.has(replacementId));
					assert(
						(yield* Ref.get(registered)).slice(registrations).some((session) => session.connectionId === replacementId),
					);
					assert.deepEqual(yield* sessions(observer, "mysql", tag).pipe(Effect.map((rows) => rows.map(([id]) => id))), [
						replacementId,
					]);
					yield* Scope.close(child, Exit.void);
					phase = "isolation_pool_closed";
					let closed = false;
					for (let index = 0; index < 100; index++) {
						closed = Exit.isSuccess(yield* inspector.assertNoSessions(Effect.void).pipe(Effect.exit));
						if (closed) break;
						yield* Effect.sleep("50 millis");
					}
					assert(closed, "Rejected isolation sessions did not disappear");
					return;
				}

				phase = "other_attempt";
				const observer = yield* open(connection, "fixture-observer");
				const otherTag = yield* attemptTag({ connection, attempt: "b2".repeat(32) });
				phase = "open_other";
				const otherAttempt = yield* open(connection, otherTag);
				phase = "query_other";
				yield* otherAttempt.unsafe("SELECT 1");
				phase = "reject_other_registration";
				assert(
					Exit.isFailure(
						yield* inspector.register({ ...inspector.server, tag: otherTag }, Effect.void).pipe(Effect.exit),
					),
				);
				const table = `remote_probe_${mode}`;
				phase = "client_ready";
				if (mode === "reject") {
					// More failures than the pool size detect leaked failed transaction leases.
					for (let index = 0; index < 6; index++) {
						const denied = yield* sql
							.withTransaction(sql.unsafe(`CREATE TABLE ${table}(value INTEGER)`))
							.pipe(Effect.exit);
						assert(Exit.isFailure(denied));
						assert(!JSON.stringify(denied).includes(settings.password));
					}
					yield* Ref.set(allow, true);
				}
				if (mode === "pending") {
					const pending = yield* sql.unsafe(`CREATE TABLE ${table}(value INTEGER)`).pipe(Effect.forkScoped);
					yield* Deferred.await(entered);
					const before = yield* observer.unsafe(
						connection.engine === "pg"
							? "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=$1"
							: "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",
						[table],
					);
					assert.equal(before.length, 0);
					yield* Ref.set(allow, true);
					yield* Deferred.succeed(acknowledge, undefined);
					yield* Fiber.join(pending);
				} else yield* sql.unsafe(`CREATE TABLE ${table}(value INTEGER)`);
				phase = "created";
				yield* sql.unsafe(`INSERT INTO ${table} VALUES(1)`);
				yield* sql.withTransaction(sql.unsafe(`INSERT INTO ${table} VALUES(2)`));
				yield* Effect.scoped(
					Effect.gen(function* () {
						const reserved = yield* sql.reserve;
						yield* reserved.executeUnprepared(`INSERT INTO ${table} VALUES(3)`, [], undefined);
					}),
				);
				const streamed = yield* sql.unsafe(`SELECT value FROM ${table} ORDER BY value`).stream.pipe(Stream.runCollect);
				assert.equal(streamed.length, 3);
				assert((yield* Ref.get(registered)).length >= 5);
				// Hold four independent leases concurrently to force real pool expansion.
				yield* Effect.all(
					Array.from({ length: 4 }, () =>
						Effect.scoped(
							Effect.gen(function* () {
								const reserved = yield* sql.reserve;
								yield* reserved.executeValues("SELECT 1", []);
								yield* Effect.sleep("100 millis");
							}),
						),
					),
					{ concurrency: 4 },
				);
				assert(new Set((yield* Ref.get(registered)).map((session) => session.connectionId)).size >= 4);
				phase = "all_access_paths";
				if (mode === "leases") {
					const safe =
						connection.engine === "pg"
							? "SELECT 9007199254740991::bigint AS n"
							: "SELECT CAST(9007199254740991 AS SIGNED) AS n";
					const unsafe =
						connection.engine === "pg"
							? "SELECT 9007199254740992::bigint AS n"
							: "SELECT CAST(9007199254740992 AS SIGNED) AS n";
					assert.deepEqual(yield* sql.unsafe(safe), [{ n: Number.MAX_SAFE_INTEGER }]);
					assert.deepEqual(yield* sql.unsafe(safe).values, [[Number.MAX_SAFE_INTEGER]]);
					assert.deepEqual(yield* sql.unsafe(safe).stream.pipe(Stream.runCollect), [{ n: Number.MAX_SAFE_INTEGER }]);
					for (const query of [
						sql.unsafe(unsafe),
						sql.unsafe(unsafe).values,
						sql.unsafe(unsafe).raw,
						sql.unsafe(unsafe).stream.pipe(Stream.runCollect),
					])
						assert(Exit.isFailure(yield* query.pipe(Effect.exit)), "Unsafe integer escaped guarded client");
					const tag = yield* attemptTag({ connection, attempt });
					const inspection = yield* observer.reserve;
					if (connection.engine === "mysql") {
						phase = "failed_query_leases_discarded";
						let live = yield* sessions(inspection, "mysql", tag).pipe(Effect.map((rows) => rows.map(([id]) => id)));
						for (let poll = 0; live.length > 0 && poll < 100; poll++) {
							yield* Effect.sleep("50 millis");
							live = yield* sessions(inspection, "mysql", tag).pipe(Effect.map((rows) => rows.map(([id]) => id)));
						}
						assert.deepEqual(live, []);
					}
					// Failed queries can discard every physical lease. Reopen one before testing live-session refusal.
					phase = "healthy_lease_after_query_failures";
					assert.deepEqual(yield* sql`SELECT 1 AS accepted`, [{ accepted: 1 }]);
					const live = yield* sessions(inspection, connection.engine, tag).pipe(
						Effect.map((rows) => rows.map(([id]) => id)),
					);
					assert(live.length > 0);
					const admitted = new Set((yield* Ref.get(registered)).map((session) => session.connectionId));
					assert(live.every((id) => admitted.has(id)));
				}

				if (mode === "stream") {
					const streaming = yield* sql
						.unsafe(connection.engine === "pg" ? "SELECT pg_sleep(20)" : "SELECT SLEEP(20)")
						.stream.pipe(Stream.runDrain, Effect.forkScoped);
					// Wait until the database itself observes the running long statement.
					let active = false;
					for (let index = 0; index < 50; index++) {
						const rows = yield* observer.unsafe(
							connection.engine === "pg"
								? "SELECT query FROM pg_stat_activity WHERE application_name LIKE 'comms:%' AND state='active'"
								: "SHOW PROCESSLIST",
						);
						active = JSON.stringify(rows).includes(connection.engine === "pg" ? "pg_sleep(20)" : "SELECT SLEEP(20)");
						if (active) break;
						yield* Effect.sleep("20 millis");
					}
					assert(active, "Long stream never reached server");
					yield* Fiber.interrupt(streaming);
					const stopped = yield* Fiber.await(streaming);
					assert(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause));
				}
				if (mode === "restart") {
					phase = "await_restart";
					yield* Effect.promise(() => writeFile(`${journal}.restart`, "ready"));
					let resumed = false;
					for (let index = 0; index < 300; index++) {
						resumed = yield* Effect.promise(() =>
							readFile(`${journal}.restarted`, "utf8").then(
								() => true,
								() => false,
							),
						);
						if (resumed) break;
						yield* Effect.sleep("100 millis");
					}
					assert(resumed, "Server restart did not complete");
					assert(Exit.isFailure(yield* inspector.assertNoSessions(Effect.void).pipe(Effect.exit)));
					return;
				}
				if (connection.engine === "pg") yield* sql.unsafe("SET application_name='cleared-by-application'");
				assert(
					Exit.isFailure(yield* inspector.assertNoSessions(Effect.fail("local closure missing")).pipe(Effect.exit)),
				);
				phase = "live_sessions_refusal";
				// Positive local proof alone does not permit acceptance while tagged sessions remain.
				assert(Exit.isFailure(yield* inspector.assertNoSessions(Effect.void).pipe(Effect.exit)));
				assert(Exit.isFailure(yield* sql.unsafe(`INSERT INTO ${table} VALUES(4)`).pipe(Effect.exit)));
				yield* Scope.close(child, Exit.void);
				phase = "child_closed";
				let closed = false;
				for (let index = 0; index < 100; index++) {
					closed = Exit.isSuccess(yield* inspector.assertNoSessions(Effect.void).pipe(Effect.exit));
					if (closed) break;
					yield* Effect.sleep("50 millis");
				}
				assert(closed, "Tagged sessions did not disappear");
				yield* otherAttempt.unsafe("SELECT 1");
				assert.equal((yield* observer.unsafe(`SELECT value FROM ${table} ORDER BY value`)).length, 3);
				phase = "verified";
			}).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
		);
		process.stdout.write(JSON.stringify({ mode, passed: true }));
	} catch {
		throw new Error(`Remote session fixture failed during ${phase}`);
	}
}
await main();
