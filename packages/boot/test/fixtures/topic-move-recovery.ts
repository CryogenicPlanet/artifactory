import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Crypto, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { AppRecovery, layer as recoveryLayer } from "../../src/app-recovery.ts";
import { Events, layer as eventsLayer, EventRecord } from "../../src/events.ts";
import { retireLegacyTopicMoves } from "../../src/legacy-topic-moves.ts";

const Input = Schema.Struct({
	op: Schema.Literals(["seed", "recover"]),
	committed: Schema.optionalKey(Schema.Boolean),
});
const main = Effect.gen(function* () {
	const root = process.argv[2];
	if (!root) return yield* Effect.die("Missing root");
	const input = yield* Schema.decodeEffect(Schema.fromJsonString(Input))(process.argv[3] ?? "{}");
	const program = Effect.gen(function* () {
		yield* initializeBootSchema;
		return yield* Effect.gen(function* () {
			const events = yield* Events;
			const sql = yield* SqlClient.SqlClient;
			if (input.op === "recover") {
				yield* retireLegacyTopicMoves(root, `${root}/comms.db`);
				return "recovered";
			}
			yield* (yield* AppRecovery).prepare("original");
			// Historical schema and hash encoding are test data, independent of the retired constructor.
			yield* sql`CREATE TABLE topic_moves (id TEXT PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,instance TEXT NOT NULL,request_key TEXT,request_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','pages_published','completed','aborted')),seq INTEGER)`;
			yield* sql`CREATE UNIQUE INDEX topic_moves_retry ON topic_moves(instance,request_key) WHERE request_key IS NOT NULL AND state<>'aborted'`;
			yield* sql`CREATE TABLE topic_page_moves (id TEXT PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,agent TEXT NOT NULL,tree TEXT,state TEXT NOT NULL CHECK(state IN ('prepared','publishing','published','completed')))`;
			yield* sql`CREATE UNIQUE INDEX topic_page_move_single_pending ON topic_page_moves((1)) WHERE state<>'completed'`;
			const fs = yield* FileSystem.FileSystem;
			const crypto = yield* Crypto.Crypto;
			const digest = (bytes: Uint8Array) =>
				crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));
			const entries: string[] = [];
			for (const suffix of ["", "/empty", "/page.md"]) {
				const filename = `${root}/pages/old${suffix}`;
				const info = yield* fs.stat(filename);
				entries.push(
					JSON.stringify({
						path: suffix,
						type: info.type,
						mode: info.mode & 0o777,
						identity: `${info.dev}:${Option.getOrNull(info.ino)}`,
						sha: info.type === "File" ? yield* digest(yield* fs.readFile(filename)) : null,
					}),
				);
			}
			const tree = yield* digest(new TextEncoder().encode(entries.join("\n")));
			yield* sql`INSERT INTO topic_moves(id,from_path,to_path,instance,request_key,request_hash,state) VALUES('move','old','new','human','retry','bound','prepared')`;
			yield* sql`INSERT INTO topic_page_moves VALUES('move','pages/old','pages/new','human',${tree},'prepared')`;
			const range = yield* events.reserve("move", 1, "original");
			if (input.committed) {
				const event = yield* Schema.encodeEffect(Schema.fromJsonString(EventRecord))({
					seq: range.from,
					at: 1,
					type: "topic.moved",
					level: "info",
					actor: "human",
					instance: "human",
					generation: 1,
					request_id: "move",
					topic: "new",
					message_id: null,
					payload: { from: "old", to: "new" },
				});
				yield* Effect.gen(function* () {
					const app = yield* SqlClient.SqlClient;
					yield* app.withTransaction(
						Effect.gen(function* () {
							yield* app`INSERT INTO mutation_batches VALUES('move',${range.from},${range.to},1)`;
							yield* app`INSERT INTO outbox VALUES(${range.from},'move',${event},NULL)`;
						}),
					);
				}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/comms.db`, disableWAL: true })), Effect.scoped);
			}
			return "seeded";
		}).pipe(Effect.provide(recoveryLayer(`${root}/comms.db`).pipe(Layer.provideMerge(eventsLayer(Effect.void)))));
	}).pipe(Effect.provide(SqliteClient.layer({ filename: `${root}/boot.db`, disableWAL: true })), Effect.result);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* program));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));
main.pipe(BunRuntime.runMain);
