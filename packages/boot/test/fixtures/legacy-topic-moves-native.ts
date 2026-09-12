import { strict as assert } from "node:assert";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Context, Crypto, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { remoteClientLayer } from "@comms/storage/remote-client";
import { remoteInspectorLayer } from "@comms/storage/remote-inspector";
import { type RemoteConnection } from "@comms/storage/remote-session";
import { hasLegacyTopicMoves } from "../../src/legacy-topic-moves.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const open = (connection: RemoteConnection, bootConnection: RemoteConnection) =>
	Effect.gen(function* () {
		const attempt = (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "").repeat(2);
		const options = { connection, attempt };
		const context = yield* Layer.build(
			remoteClientLayer({ ...options, register: () => Effect.void }).pipe(
				Layer.provide(
					remoteInspectorLayer({
						...options,
						...(connection.engine === "mysql" ? { mysqlBootConnection: bootConnection } : {}),
					}),
				),
			),
		);
		return Context.get(context, SqlClient.SqlClient);
	});
const main = Effect.gen(function* () {
	const [directory, engine] = process.argv.slice(2);
	if (!directory || (engine !== "pg" && engine !== "mysql"))
		return yield* Effect.die("Expected disposable native configs");
	const fs = yield* FileSystem.FileSystem;
	const config = yield* fs
		.readFileString(`${directory}/${engine}-initialize-boot.json`)
		.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))));
	if (config.database !== "comms_initialize_boot" || config.engine !== engine)
		return yield* Effect.die("Refusing non-disposable store");
	const connection: RemoteConnection = { ...config, password: Redacted.make(config.password), tls: false };
	const sql = yield* open(connection, connection);
	assert.equal(yield* hasLegacyTopicMoves(sql), false);
	for (const table of ["topic_moves", "topic_page_moves", "TOPIC_MOVES"]) {
		yield* sql`CREATE TABLE ${sql(table)} (evidence TEXT)`;
		yield* Effect.gen(function* () {
			assert.equal(yield* hasLegacyTopicMoves(sql), true);
			yield* sql`INSERT INTO ${sql(table)} VALUES('opaque historical evidence')`;
			assert.equal(yield* hasLegacyTopicMoves(sql), true);
			assert.deepEqual(yield* sql`SELECT evidence FROM ${sql(table)}`, [{ evidence: "opaque historical evidence" }]);
		}).pipe(Effect.ensuring(sql`DROP TABLE ${sql(table)}`.pipe(Effect.orDie)));
		assert.equal(yield* hasLegacyTopicMoves(sql), false);
	}
	yield* sql`CREATE VIEW topic_moves AS SELECT 1 AS evidence`;
	yield* hasLegacyTopicMoves(sql).pipe(
		Effect.tap((found) => Effect.sync(() => assert.equal(found, false))),
		Effect.ensuring(sql`DROP VIEW topic_moves`.pipe(Effect.orDie)),
	);
	return { engine, passed: true };
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(Reactivity.layer));
main.pipe(
	Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))),
	Effect.flatMap(Console.log),
	BunRuntime.runMain,
);
