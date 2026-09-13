import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Context, Effect, Exit, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import type { RemoteConnection } from "@comms/storage/remote-session";

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
const sqlLayer = advisoryClientLayer({ connection });
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
		}
	}),
);
process.stdout.write(`TLS ${settings.engine} ${mode} ${host}: starting\n`);
try {
	await Effect.runPromise(
		mode === "deny"
			? query.pipe(
					Effect.exit,
					Effect.map((result) => assert(Exit.isFailure(result), "Untrusted SQL handshake accepted")),
				)
			: query,
	);
	process.stdout.write(`TLS ${settings.engine} ${mode} ${host}: passed\n`);
} catch {
	throw new Error(`TLS ${settings.engine} ${mode} ${host} failed during query`);
}
