// Opt-in diagnostic, not a runtime service or a substitute for guardian process acceptance.
import assert from "node:assert/strict";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Context, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema, Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer, RemoteInspector } from "@comms/storage/remote-inspector";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { remoteOwner } from "../../src/remote-owner.ts";

const Configuration = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const summarize = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	assert(sorted.length > 0);
	return {
		count: sorted.length,
		mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
		p50: sorted[Math.floor(sorted.length * 0.5)],
		p95: sorted[Math.floor(sorted.length * 0.95)],
		max: sorted.at(-1),
	};
};
const sample = <A, E, R>(effect: Effect.Effect<A, E, R>, samples: number[]) =>
	Effect.gen(function* () {
		const start = performance.now();
		const value = yield* effect;
		samples.push(performance.now() - start);
		return value;
	});
const main = Effect.gen(function* () {
	assert(process.env.COMMS_DISPOSABLE_BENCHMARK === "1", "Disposable benchmark opt-in required");
	const [configurationFile, output] = process.argv.slice(2);
	assert(configurationFile && output, "CONFIG REPORT required");
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	assert.equal((yield* fs.stat(configurationFile)).mode & 0o077, 0, "Private configuration required");
	const config = yield* fs
		.readFileString(configurationFile)
		.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Configuration))));
	assert(["127.0.0.1", "localhost"].includes(config.host));
	assert(/^comms_benchmark_[a-z0-9_]+$/.test(config.database));
	const connection = { ...config, password: Redacted.make(config.password), tls: false };
	const rawSamples: number[] = [];
	const version = yield* Effect.scoped(
		Effect.gen(function* () {
			const options = {
				host: config.host,
				port: config.port,
				database: config.database,
				username: config.username,
				password: connection.password,
				maxConnections: 4,
			};
			const raw = yield* config.engine === "pg"
				? PgClient.make({ ...options, multiplex: false })
				: MysqlClient.make(options);
			const version = yield* raw`SELECT version() AS version`;
			yield* raw`SELECT 1`;
			for (let i = 0; i < 200; i++) yield* sample(raw`SELECT 1`, rawSamples);
			return version;
		}),
	);
	const root = yield* fs.makeTempDirectory({ prefix: "comms-lease-cost-" }).pipe(Effect.flatMap(fs.realPath));
	yield* fs.chmod(root, 0o700);
	const attempt = "bc".repeat(32);
	const owner = yield* remoteOwner(root, {
		engine: config.engine,
		host: config.host,
		port: config.port,
		database: config.database,
		username: config.username,
		tls: false,
		attempt,
		root: attempt,
		scope: "database",
	});
	const inspectionScope = yield* Scope.fork(yield* Effect.scope);
	const inspectionContext = yield* Scope.provide(
		Layer.build(remoteInspectorLayer({ connection, attempt })),
		inspectionScope,
	);
	const inspector = Context.get(inspectionContext, RemoteInspector);
	yield* owner.bindInspector(inspector.server);
	const registration: number[] = [],
		firstRegistration: number[] = [];
	const known = new Set<string>();
	const clientScope = yield* Scope.fork(yield* Effect.scope);
	const clientContext = yield* Scope.provide(
		Layer.build(
			guardianClientLayer({
				connection,
				attempt,
				register: (session) =>
					inspector.register(
						session,
						Effect.gen(function* () {
							const first = !known.has(session.connectionId);
							yield* sample(owner.register(session), first ? firstRegistration : registration);
							known.add(session.connectionId);
						}),
					),
			}),
		),
		clientScope,
	);
	const sql = Context.get(clientContext, SqlClient);
	const firstQuery: number[] = [],
		acquired: number[] = [],
		retained: number[] = [];
	yield* sample(sql`SELECT 1`, firstQuery);
	for (let i = 0; i < 200; i++) yield* sample(sql`SELECT 1`, acquired);
	const beforeRetained = registration.length + firstRegistration.length;
	yield* Effect.scoped(
		Effect.gen(function* () {
			const lease = yield* sql.reserve;
			for (let i = 0; i < 200; i++) yield* sample(lease.executeValues("SELECT 1", []), retained);
		}),
	);
	assert.equal(
		registration.length + firstRegistration.length - beforeRetained,
		1,
		"Retained lease must acquire exactly once",
	);
	assert.equal(acquired.length, 200);
	const sessions = yield* fs
		.readFileString(path.join(root, "remote-owners", `${attempt}.json`))
		.pipe(
			Effect.flatMap(
				Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ sessions: Schema.Array(Schema.Unknown) }))),
			),
		);
	assert.equal(sessions.sessions.length, known.size);
	yield* Scope.close(clientScope, Exit.void);
	yield* owner.close(inspector.assertNoSessions(Effect.void));
	yield* Scope.close(inspectionScope, Exit.void);
	const report = {
		engine: config.engine,
		server: version,
		runtime: process.versions.bun,
		platform: process.platform,
		arch: process.arch,
		mode: "Loopback guarded primitives with real inspector and owner receipt; guardian IPC excluded",
		milliseconds: {
			raw_pooled_query: summarize(rawSamples),
			first_registered_query: summarize(firstQuery),
			guarded_pooled_query: summarize(acquired),
			retained_guarded_lease_query: summarize(retained),
			new_session_receipt: summarize(firstRegistration),
			repeated_session_acknowledgment: summarize(registration),
		},
		registered_physical_sessions: known.size,
		registration_calls: firstRegistration.length + registration.length,
		timed_queries_completed: 601,
		owner_closed: true,
		artifacts_directory: root,
		limitations:
			"Sequential warm SELECT 1; no TLS, injected network delay, guardian IPC, query workload or contention capacity claim",
	};
	const file = yield* fs.open(output, { flag: "wx", mode: 0o600 });
	yield* file.writeAll(new TextEncoder().encode(JSON.stringify(report, null, 2) + "\n"));
	yield* file.sync;
}).pipe(
	Effect.scoped,
	Effect.provide(Reactivity.layer),
	Effect.provide(BunServices.layer),
	Effect.catchCause(() =>
		Effect.sync(() => {
			console.error("Lease benchmark failed; private artifacts retained.");
			process.exitCode = 1;
		}),
	),
);
main.pipe(BunRuntime.runMain);
