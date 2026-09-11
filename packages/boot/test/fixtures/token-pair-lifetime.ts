/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Effect, Layer, Result, Schema } from "effect";
import { ReceiptError } from "../../src/refresh-receipt.ts";
import { tokenSession } from "./token-session.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
await Effect.runPromise(
	Effect.gen(function* () {
		const fixture = yield* tokenSession;
		const { auth, sql, grant, advance, now } = fixture;
		yield* Effect.gen(function* () {
			if (scenario === "independent") {
				for (const long of [false, true]) {
					const original = yield* grant(long);
					yield* sql`DELETE FROM enrollments WHERE family=${original.family}`;
					// Scope order is not part of a grant. Expired access remains durable lifetime evidence.
					yield* sql`UPDATE tokens SET scopes='["fs","write","read"]' WHERE family=${original.family} AND kind='access'`;
					yield* advance(long ? 604_800_001 : 86_400_001);
					const rotated = yield* auth.refreshTokens(original.refresh);
					assert.equal(rotated.expires_at - now(), long ? 604_800_000 : 86_400_000);
					assert.equal(rotated.refresh_expires_at - now(), long ? 7_776_000_000 : 2_592_000_000);
					assert.equal(rotated.family, original.family);
					assert.deepEqual(rotated.scopes, original.scopes);
					// Another rotation must use its exact pair even while prior pairs remain in this family.
					const next = yield* auth.refreshTokens(rotated.refresh);
					assert.equal(next.expires_at, rotated.expires_at);
					assert.equal(next.refresh_expires_at, rotated.refresh_expires_at);
					assert.deepEqual(yield* auth.refreshTokens(original.refresh), rotated);
				}
			} else if (scenario === "malformed") {
				const original = yield* grant();
				yield* sql`DELETE FROM enrollments WHERE family=${original.family}`;
				const before = yield* sql`SELECT * FROM tokens`;
				for (const change of [
					"DELETE FROM tokens WHERE kind='access'",
					"UPDATE tokens SET pair_id='other' WHERE kind='access'",
					"UPDATE tokens SET family='other' WHERE kind='access'",
					"UPDATE tokens SET agent='other' WHERE kind='access'",
					"UPDATE tokens SET label='other' WHERE kind='access'",
					"UPDATE tokens SET created_at=created_at+1 WHERE kind='access'",
					"UPDATE tokens SET revoked_at=1 WHERE kind='access'",
					"UPDATE tokens SET rotated_at=1 WHERE kind='refresh'",
					"UPDATE tokens SET scopes='[\"read\"]' WHERE kind='access'",
					'UPDATE tokens SET scopes=\'["read","read","fs"]\'',
					"UPDATE tokens SET scopes='[]'",
					"UPDATE tokens SET scopes='broken' WHERE kind='access'",
					"UPDATE tokens SET scopes='broken' WHERE kind='refresh'",
					"UPDATE tokens SET expires_at=created_at+604800000 WHERE kind='access'",
					"UPDATE tokens SET expires_at=expires_at+1 WHERE kind='refresh'",
					"INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) SELECT 'extra',pair_id,family,agent,kind,'extra-hash',label,scopes,expires_at,created_at FROM tokens WHERE kind='access'",
					"INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at) SELECT 'extra',pair_id,family,agent,kind,'extra-hash',label,scopes,expires_at,created_at FROM tokens WHERE kind='refresh'",
				]) {
					yield* sql.unsafe(change);
					const broken = yield* sql`SELECT * FROM tokens`;
					const outcome = yield* auth.refreshTokens(original.refresh, "attempt").pipe(Effect.result);
					assert.ok(Result.isFailure(outcome), change);
					assert.ok(Schema.is(ReceiptError)(outcome.failure), change);
					assert.deepEqual(yield* sql`SELECT * FROM tokens`, broken, change);
					assert.deepEqual(yield* sql`SELECT * FROM refresh_receipts`, []);
					assert.deepEqual(yield* sql`SELECT * FROM refresh_idempotency`, []);
					assert.deepEqual(yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.refreshed'`, []);
					yield* sql`DELETE FROM tokens`;
					for (const row of before) yield* sql`INSERT INTO tokens ${sql.insert(row)}`;
				}
			} else throw new Error("Unknown scenario");
		}).pipe(Effect.provideService(Clock.Clock, fixture.clock));
	}).pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename, disableWAL: true }), BunServices.layer)),
	),
);
await Effect.runPromise(Console.log("pair lifetime scenario passed"));
