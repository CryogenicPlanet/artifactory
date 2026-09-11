/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Crypto, Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";

const filename = process.argv[2];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	yield* initializeBootSchema;
	const hash = (secret: string) =>
		crypto
			.digest("SHA-256", new TextEncoder().encode(secret))
			.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
	if (process.argv[3] !== "resume") {
		yield* sql`INSERT INTO passkeys VALUES('saved','unused',0,'[]','saved',1)`;
		yield* sql`INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('human',${yield* hash("b".repeat(43))},2,9999999999999)`;
		// A real v9 session has no presence column. Migration must retain its hash and leave unknown activity null.
		yield* sql`ALTER TABLE child_attempts DROP COLUMN boot_id`;
		yield* sql`ALTER TABLE backups DROP COLUMN published_through`;
		yield* sql`ALTER TABLE backups DROP COLUMN generation`;
		yield* sql`DROP TABLE mint_receipts`;
		yield* sql`ALTER TABLE sessions DROP COLUMN last_seen_at`;
		yield* sql`ALTER TABLE events DROP COLUMN topic`;
		yield* sql`DROP TABLE topic_moves`;
		yield* sql`DROP TABLE topic_page_moves`;
		yield* sql`DROP TABLE db_restore_requests`;
		yield* sql`ALTER TABLE source_changes DROP COLUMN before_directory`;
		yield* sql`ALTER TABLE source_changes DROP COLUMN desired_directory`;
		yield* sql`ALTER TABLE versions DROP COLUMN previous_directory`;
		yield* sql`ALTER TABLE versions DROP COLUMN directory`;
		yield* sql`PRAGMA user_version=9`;
		yield* initializeBootSchema;
		assert.deepEqual(yield* sql`SELECT id,created_at,last_seen_at FROM sessions`, [
			{ id: "human", created_at: 2, last_seen_at: null },
		]);
		yield* sql`INSERT INTO enrollments VALUES('enrolled','device-hash','code','codex','codex','laptop','collected','family',1,100,3,'["read"]',100,100)`;
		yield* sql`INSERT INTO enrollments VALUES('pending','private-device','private-code','hidden','codex','private-host','pending','pending-family',1,100,NULL,NULL,NULL,NULL)`;
		yield* sql`INSERT INTO tokens VALUES('old','old-pair','family','codex','access','old-hash','laptop','["read"]',1,3,100,NULL,NULL,NULL)`;
		yield* sql`INSERT INTO tokens VALUES('access','pair','family','codex','access',${yield* hash("a".repeat(43))},'laptop','["read"]',9999999999999,4,NULL,NULL,NULL,NULL)`;
		yield* sql`INSERT INTO tokens VALUES('refresh','pair','family','codex','refresh','refresh-hash','laptop','["read"]',9999999999999,4,9999999999999,NULL,NULL,NULL)`;
	}
	yield* Effect.gen(function* () {
		const auth = yield* Auth;
		const before = yield* auth.roster;
		assert.deepEqual(
			before.items.map((item) => [item.agent, item.kind, item.instance, item.label, item.created_at]),
			[
				["codex", "codex", "family", "laptop", 3],
				["rahul", "human", "human", "human", 2],
			],
		);
		if (process.argv[3] === "resume") {
			assert.ok(before.items.every((item) => item.last_seen_at !== null && item.last_seen_at > 100));
			yield* auth.logout("b".repeat(43));
			assert.equal((yield* auth.roster).items.length, 1);
			// Human-minted families have no enrollment, and still belong in the app roster.
			yield* sql`INSERT INTO tokens VALUES('mint-access','mint-pair','mint-family','pi','access','mint-hash','job','["read"]',9999999999999,5,200,NULL,NULL,NULL)`;
			assert.deepEqual(
				(yield* auth.roster).items.find((item) => item.instance === "mint-family"),
				{
					agent: "pi",
					kind: "agent",
					instance: "mint-family",
					label: "job",
					created_at: 5,
					last_seen_at: 200,
				},
			);
			return;
		}
		assert.deepEqual(
			before.items.map((item) => item.last_seen_at),
			[100, null],
		);
		assert.ok(Result.isFailure(yield* auth.authenticateSession("invalid").pipe(Effect.result)));
		assert.ok(Result.isFailure(yield* auth.authenticateAccess("invalid").pipe(Effect.result)));
		assert.deepEqual(yield* auth.roster, before);
		yield* auth.authenticateSession("b".repeat(43));
		yield* auth.authenticateAccess("a".repeat(43));
		const active = yield* auth.roster;
		assert.ok(
			active.items.every(
				(item) => item.last_seen_at !== null && item.last_seen_at > 100 && item.last_seen_at < 9999999999999,
			),
		);
		assert.deepEqual(Object.keys(active.items[0] ?? {}).sort(), [
			"agent",
			"created_at",
			"instance",
			"kind",
			"label",
			"last_seen_at",
		]);
		yield* sql`UPDATE tokens SET revoked_at=1 WHERE family='family'`;
		assert.ok(Result.isFailure(yield* auth.authenticateAccess("a".repeat(43)).pipe(Effect.result)));
		assert.deepEqual(yield* auth.roster, active);
	}).pipe(
		Effect.provide(
			authLayer({ rpId: "localhost", expectedOrigin: "http://localhost" }).pipe(
				Layer.provide(Layer.mergeAll(eventsLayer, lockLayer)),
			),
		),
	);
});
await Effect.runPromise(
	run.pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename, disableWAL: true }), BunServices.layer)),
	),
);
await Effect.runPromise(Console.log("presence passed"));
