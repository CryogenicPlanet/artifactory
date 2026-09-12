import { strict as assert } from "node:assert";
import { appendFile, open, readFile } from "node:fs/promises";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Exit, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "../../src/remote-client.ts";
import { remoteInspectorLayer } from "../../src/remote-inspector.ts";
import { dumpRemote, loadRemote } from "../../src/remote-copy.ts";
import type { RemoteConnection } from "../../src/remote-session.ts";
import type { RemoteStore } from "../../src/store.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	password: Schema.String,
});
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile("/fixture/client.json", "utf8"));
const mode = process.argv[2];
const host = process.argv[3];
assert(mode === "seed" || mode === "pass" || mode === "deny");
assert(host === "database.test" || host === "wrong.test");
const connection: RemoteConnection = {
	engine: settings.engine,
	host,
	port: settings.engine === "pg" ? 5432 : 3306,
	database: "comms_tls",
	username: "comms_tls",
	password: Redacted.make(settings.password),
	tls: true,
};
const store: RemoteStore = {
	_tag: settings.engine === "pg" ? "postgres" : "mysql",
	database: connection.database,
	url: Redacted.make(
		`${settings.engine === "pg" ? "postgres" : "mysql"}://comms_tls:${settings.password}@${host}:${connection.port}/comms_tls`,
	),
};
const attempt = "a1".repeat(32);
const sqlLayer = remoteClientLayer({
	connection,
	attempt,
	register: (session) =>
		Effect.promise(async () => {
			await appendFile("/artifacts/registered", `${JSON.stringify(session)}\n`, { mode: 0o600 });
			const journal = await open("/artifacts/registered", "r+");
			try {
				await journal.sync();
			} finally {
				await journal.close();
			}
		}),
}).pipe(Layer.provide(remoteInspectorLayer({ connection, attempt })));
const query = Effect.scoped(
	Effect.gen(function* () {
		const sql = Context.get(yield* Layer.build(sqlLayer), SqlClient);
		// Check the actual admitted session is encrypted, not merely that a boolean was supplied.
		if (settings.engine === "pg") {
			const rows = yield* sql.unsafe<{ readonly ssl: boolean }>(
				"SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
			);
			assert.equal(rows[0]?.ssl, true);
		} else {
			const rows = yield* sql.unsafe<{ readonly Value: string }>("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
			assert(rows[0]?.Value);
		}
		if (mode === "seed") {
			yield* sql.unsafe("CREATE TABLE tls_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			yield* sql.unsafe("INSERT INTO tls_probe VALUES (1, 'verified private CA')");
		} else if (mode === "pass") {
			const rows = yield* sql.unsafe("SELECT * FROM tls_probe");
			assert.deepEqual(rows, [{ id: 1, value: "verified private CA" }]);
			yield* sql.unsafe("DROP TABLE tls_probe");
		}
	}),
);
const artifact = { path: "/artifacts/trusted.dump", engine: settings.engine };
const options = { store, budget: "15 seconds", tls: true } as const;
let phase = "query";
try {
	await Effect.runPromise(
		Effect.gen(function* () {
			if (mode === "deny") {
				assert(Exit.isFailure(yield* query.pipe(Effect.exit)), "Untrusted SQL handshake accepted");
				phase = "dump_refusal";
				const dump = yield* dumpRemote({ ...options, path: "/artifacts/rejected.dump" }).pipe(Effect.exit);
				assert(Exit.isFailure(dump));
				assert(JSON.stringify(dump).includes("backup_failed"));
				phase = "load_refusal";
				const load = yield* loadRemote({ ...options, artifact }).pipe(Effect.exit);
				assert(Exit.isFailure(load));
				assert(JSON.stringify(load).includes("clone_load_failed"));
			} else if (mode === "seed") {
				yield* query;
				phase = "dump";
				assert((yield* dumpRemote({ ...options, path: artifact.path })).bytes > 0);
				phase = "clear";
				yield* Effect.scoped(
					Effect.gen(function* () {
						const sql = Context.get(yield* Layer.build(sqlLayer), SqlClient);
						yield* sql.unsafe("DROP TABLE tls_probe");
					}),
				);
			} else {
				phase = "load";
				// The target is empty before each load. A negative load cannot pass by colliding with an existing table.
				yield* loadRemote({ ...options, artifact });
				phase = "verify_restored_query";
				yield* query;
			}
		}).pipe(Effect.provide(BunServices.layer), Effect.scoped),
	);
	process.stdout.write(`TLS ${settings.engine} ${mode} ${host}: passed\n`);
} catch {
	throw new Error(`TLS fixture failed during ${phase}`);
}
