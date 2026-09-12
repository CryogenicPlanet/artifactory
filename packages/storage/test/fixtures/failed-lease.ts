import * as PgClient from "@effect/sql-pg/PgClient";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Deferred, Effect, Exit, Fiber, FileSystem, Redacted, Ref, Schema } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const Settings = Schema.fromJsonString(
	Schema.Struct({
		engine: Schema.Literals(["pg", "mysql"]),
		host: Schema.String,
		port: Schema.Int,
		database: Schema.Literal("comms_failed_lease"),
		username: Schema.String,
		password: Schema.String,
	}),
);
const Modes = Schema.Literals(["commit", "rollback", "success-rollback", "nested"]);
const Id = Schema.Array(Schema.Struct({ id: Schema.String }));
const Count = Schema.Array(Schema.Struct({ count: Schema.Int }));

const main = Effect.gen(function* () {
	const phase = yield* Ref.make("configuration");
	const run = Effect.gen(function* () {
		const mode = yield* Schema.decodeUnknownEffect(Modes)(process.argv[2]);
		const filename = yield* Config.String("COMMS_FAILED_LEASE_CONFIG");
		const fs = yield* FileSystem.FileSystem;
		const info = yield* fs.stat(filename);
		if (info.type !== "File" || (info.mode & 0o077) !== 0) return yield* Effect.die("Unprotected fixture config");
		const settings = yield* fs.readFileString(filename).pipe(Effect.flatMap(Schema.decodeEffect(Settings)));
		const options = { ...settings, password: Redacted.make(settings.password), maxConnections: 1 };
		yield* Ref.set(phase, "open_native_pool");
		const raw =
			settings.engine === "pg"
				? yield* PgClient.make({ ...options, multiplex: false, idleTimeout: "1 minute" })
				: yield* MysqlClient.make(options);
		const compiler = settings.engine === "pg" ? PgClient.makeCompiler() : MysqlClient.makeCompiler();
		const broken = yield* SqlClient.make({
			acquirer: raw.reserve,
			compiler,
			spanAttributes: [],
			...(mode === "commit" ? { commit: "INVALID COMMIT" } : {}),
			...(mode === "rollback" ? { rollback: "INVALID ROLLBACK" } : {}),
			...(mode === "nested" ? { rollbackSavepoint: () => "INVALID ROLLBACK TO SAVEPOINT" } : {}),
		});
		const table = `failed_lease_${mode.replaceAll("-", "_")}`;
		yield* Ref.set(phase, "fixture_table");
		// Only this fixed disposable database is accepted above. No board schema is opened.
		yield* raw`DROP TABLE IF EXISTS ${raw(table)}`;
		yield* raw`CREATE TABLE ${raw(table)} (id INTEGER PRIMARY KEY)`;
		yield* Effect.addFinalizer(() => raw`DROP TABLE IF EXISTS ${raw(table)}`.pipe(Effect.orDie));
		const backendId = (sql: SqlClient.SqlClient) =>
			(settings.engine === "pg"
				? sql`SELECT pg_backend_pid()::text AS id`
				: sql`SELECT CAST(CONNECTION_ID() AS CHAR) AS id`
			).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Id)),
				Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0].id) : Effect.die("Missing backend id"))),
			);
		const count = (sql: SqlClient.SqlClient, id: number) =>
			(settings.engine === "pg"
				? sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM ${sql(table)} WHERE id=${id}`
				: sql`SELECT CAST(COUNT(*) AS SIGNED) AS count FROM ${sql(table)} WHERE id=${id}`
			).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Count)),
				Effect.map((rows) => rows[0]?.count ?? -1),
			);

		if (mode === "nested") {
			const before = yield* backendId(raw);
			const caught = yield* Ref.make(false);
			yield* Ref.set(phase, "nested_cleanup_diagnostic");
			const outer = yield* broken
				.withTransaction(
					Effect.gen(function* () {
						yield* broken`INSERT INTO ${broken(table)} VALUES(1)`;
						yield* broken
							.withTransaction(
								broken`INSERT INTO ${broken(table)} VALUES(2)`.pipe(Effect.andThen(Effect.fail("nested_body"))),
							)
							.pipe(Effect.catchCause(() => Ref.set(caught, true)));
					}),
				)
				.pipe(Effect.exit);
			return {
				diagnostic: true,
				mode,
				engine: settings.engine,
				outerExit: outer._tag,
				caughtNestedFailure: yield* Ref.get(caught),
				rows: { outer: yield* count(raw, 1), nested: yield* count(raw, 2) },
				beforeBackend: before,
				afterBackend: yield* backendId(raw),
			};
		}

		const entered = yield* Deferred.make<string>();
		const releaseBody = yield* Deferred.make<void>();
		const failureEntered = yield* Deferred.make<void>();
		const releaseFailure = yield* Deferred.make<void>();
		const borrowerRequested = yield* Deferred.make<void>();
		const borrowerAcquired = yield* Deferred.make<void>();
		const borrower = yield* SqlClient.make({
			acquirer: Deferred.succeed(borrowerRequested, undefined).pipe(
				Effect.andThen(raw.reserve),
				Effect.tap(() => Deferred.succeed(borrowerAcquired, undefined)),
			),
			compiler,
			spanAttributes: [],
		});
		return yield* Effect.gen(function* () {
			yield* Ref.set(phase, "owner_transaction_body");
			const owner = yield* broken
				.withTransaction(
					Effect.gen(function* () {
						yield* broken`INSERT INTO ${broken(table)} VALUES(1)`;
						yield* Deferred.succeed(entered, yield* backendId(broken));
						yield* Deferred.await(releaseBody);
						if (mode !== "commit") return yield* Effect.fail("owner_body");
					}),
				)
				.pipe(
					Effect.catchCause((cause) =>
						Deferred.succeed(failureEntered, undefined).pipe(
							Effect.andThen(Deferred.await(releaseFailure)),
							Effect.andThen(Effect.failCause(cause)),
						),
					),
					Effect.exit,
					Effect.forkScoped({ startImmediately: true }),
				);
			const before = yield* Deferred.await(entered);
			yield* Ref.set(phase, "queue_second_borrower");
			const queued = yield* borrower
				.withTransaction(
					Effect.gen(function* () {
						yield* Deferred.await(failureEntered);
						const id = yield* backendId(borrower);
						const sentinelRows = yield* count(borrower, 1);
						yield* borrower`INSERT INTO ${borrower(table)} VALUES(2)`;
						return { id, sentinelRows };
					}),
				)
				.pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
			yield* Deferred.await(borrowerRequested);
			yield* Effect.yieldNow;
			const queuedBeforeRelease = !(yield* Deferred.isDone(borrowerAcquired));
			yield* Ref.set(phase, "failed_boundary_before_outer_handler");
			yield* Deferred.succeed(releaseBody, undefined);
			yield* Deferred.await(failureEntered);
			yield* Ref.set(phase, "borrower_while_failure_handler_held");
			const observed = yield* Fiber.join(queued);
			if (Exit.isFailure(observed)) return yield* Effect.die("Queued borrower failed");
			const failureHandlerHeld = !(yield* Deferred.isDone(releaseFailure));
			const independentRows = yield* count(raw, 2);
			yield* Deferred.succeed(releaseFailure, undefined);
			const ownerExit = yield* Fiber.join(owner);
			return {
				ok: true,
				mode,
				engine: settings.engine,
				ownerFailed: Exit.isFailure(ownerExit),
				queuedBeforeRelease,
				failureHandlerHeld,
				differentBackend: before !== observed.value.id,
				sentinelRows: observed.value.sentinelRows,
				independentRows,
			};
		}).pipe(
			Effect.ensuring(
				Deferred.succeed(releaseBody, undefined).pipe(Effect.andThen(Deferred.succeed(releaseFailure, undefined))),
			),
		);
	});
	yield* run.pipe(
		Effect.scoped,
		Effect.interruptible,
		Effect.timeout("15 seconds"),
		Effect.catchCause(() => Ref.get(phase).pipe(Effect.map((phase) => ({ ok: false, phase })))),
		Effect.flatMap((report) => Console.log(JSON.stringify(report))),
	);
});

main.pipe(Effect.provide([BunServices.layer, Reactivity.layer]), BunRuntime.runMain);
