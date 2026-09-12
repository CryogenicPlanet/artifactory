import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { initializeRemoteBootSchema } from "../../src/remote-boot-schema.ts";
const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
// Run only against a fresh, disposable database; this fixture never drops or clears a store.
const filename = process.env.COMMS_REMOTE_BOOT_TEST_CONFIG;
if (!filename) throw new Error("Missing disposable config");
const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
if (!settings.database.startsWith("comms_schema_")) throw new Error("Disposable schema database required");
const options = {
	connection: { ...settings, password: Redacted.make(settings.password), tls: false },
	attempt: "a1".repeat(32),
};
const layer = remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
	Layer.provide(remoteInspectorLayer(options)),
);
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		yield* initializeRemoteBootSchema(sql, settings.engine);
		yield* initializeRemoteBootSchema(sql, settings.engine);
		{
			const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				effect.pipe(
					Effect.result,
					Effect.map((result) => assert.equal(result._tag, "Failure")),
				);
			const seq = yield* sql`SELECT ${sql("next")},published_through FROM seq WHERE singleton=1`;
			assert.deepEqual(seq, [{ next: 1, published_through: 0 }]);
			const path = `pages/${"雪😀segment/".repeat(600)}file.md`;
			const bytes = new Uint8Array([0, 128, 255]);
			yield* sql`INSERT INTO staging(lock_id,path,content,sha,at,mode) VALUES ('fixture',${path},${bytes},'a',9007199254740991,420)`;
			const staged = yield* sql`SELECT path,content,at FROM staging WHERE path=${path}`;
			assert.equal(staged[0]?.path, path);
			assert.deepEqual(Schema.decodeUnknownSync(Schema.Uint8Array)(staged[0]?.content), bytes);
			assert.equal(staged[0]?.at, 9007199254740991);
			yield* expectFailure(
				sql`INSERT INTO staging(lock_id,path,content,sha,at) VALUES ('fixture',${path},NULL,NULL,1)`,
			);
			yield* expectFailure(sql`INSERT INTO staging(lock_id,path,content,sha,at) VALUES ('fixture','bad',NULL,'a',1)`);
			yield* sql`INSERT INTO public_paths(path) VALUES (${path}),(${path + "X"})`;
			assert.equal((yield* sql`SELECT path FROM public_paths WHERE path=${path}`).length, 1);
			const credential = "A".repeat(6000);
			yield* sql`INSERT INTO passkeys(id,public_key,counter,transports,label,created_at) VALUES (${credential},'key',0,'[]','fixture',1)`;
			assert.equal((yield* sql`SELECT id FROM passkeys WHERE id=${credential}`)[0]?.id, credential);
			yield* expectFailure(
				sql`INSERT INTO passkeys(id,public_key,counter,transports,label,created_at) VALUES (${credential},'key',0,'[]','fixture',1)`,
			);
			const event = { type: "type".repeat(2000), actor: "actor".repeat(2000), instance: "null", level: "info" };
			yield* sql`INSERT INTO events(seq,event) VALUES (1,${JSON.stringify(event)})`;
			const projected = yield* sql`SELECT ${sql("type")},actor,instance FROM events WHERE seq=1`;
			assert.equal(projected[0]?.type, event.type);
			assert.equal(projected[0]?.actor, event.actor);
			assert.equal(projected[0]?.instance, "null");
			yield* sql`INSERT INTO events(seq,event) VALUES (2,${JSON.stringify({ ...event, instance: null })})`;
			assert.equal((yield* sql`SELECT instance FROM events WHERE seq=2`)[0]?.instance, null);
			yield* sql`INSERT INTO source_batches(id,agent,at,state) VALUES ('first','agent',1,'publishing')`;
			yield* expectFailure(sql`INSERT INTO source_batches(id,agent,at,state) VALUES ('second','agent',1,'publishing')`);
			yield* sql`UPDATE source_batches SET state='published' WHERE id='first'`;
			yield* sql`INSERT INTO source_batches(id,agent,at,state) VALUES ('second','agent',1,'publishing')`;
			yield* sql`INSERT INTO sessions(id,hash,created_at,expires_at) VALUES ('session','hash',1,2)`;
			yield* expectFailure(sql`INSERT INTO sessions(id,hash,created_at,expires_at) VALUES ('duplicate','hash',1,2)`);
			yield* sql`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES ('first','hash','session','backup','authorized',0)`;
			yield* expectFailure(
				sql`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES ('second','hash','session','backup','working',0)`,
			);
			yield* sql`UPDATE db_restore_requests SET phase='restored' WHERE proof_id='first'`;
			yield* sql`INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,restored_to_seq) VALUES ('second','hash','session','backup','working',0)`;
			yield* expectFailure(sql`INSERT INTO seq(singleton,${sql("next")},published_through) VALUES (2,1,0)`);
			yield* initializeRemoteBootSchema(sql, settings.engine);
			assert.equal((yield* sql`SELECT path FROM staging WHERE lock_id='fixture'`)[0]?.path, path);
			assert.equal((yield* sql`SELECT migration_id FROM boot_migrations`).length, 19);
			process.stdout.write("boot native constraints, long values, binary, sequence and reopen durability passed\n");
		}
	}).pipe(Effect.scoped, Effect.provide(layer)),
);

// A new scope creates new physical connections; preserve data after closing the first client.
await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient;
		yield* initializeRemoteBootSchema(sql, settings.engine);
		assert.equal(
			(yield* sql`SELECT path FROM staging WHERE lock_id='fixture'`)[0]?.path,
			`pages/${"雪😀segment/".repeat(600)}file.md`,
		);
		assert.equal((yield* sql`SELECT id FROM passkeys`)[0]?.id, "A".repeat(6000));
	}).pipe(Effect.scoped, Effect.provide(layer)),
);
process.stdout.write("boot native constraints, long values, binary, sequence and reopen durability passed\n");
