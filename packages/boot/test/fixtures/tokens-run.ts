import { layer as durableEventsLayer } from "../../src/events.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { Auth, layer } from "../../src/auth.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { TokenPair } from "../../src/refresh-schema.ts";
import { fails, tokenSession } from "./token-session.ts";

const editLockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const saved = Schema.Struct({ original: TokenPair, rotated: TokenPair });
const run = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	if (scenario === "resume" || scenario === "crash-resume") {
		yield* initializeBootSchema;
		const data = yield* Schema.decodeEffect(Schema.fromJsonString(saved))(
			yield* fs.readFileString(`${filename}.secrets`),
		);
		return yield* Effect.gen(function* () {
			const auth = yield* Auth;
			const replay = yield* auth.refreshTokens(data.original.refresh, "retry");
			assert.deepEqual(replay, data.rotated);
			assert.equal((yield* auth.authenticateAccess(data.original.access)).id, data.original.family);
			assert.equal((yield* auth.authenticateAccess(data.rotated.access)).id, data.original.family);
		}).pipe(
			Effect.provide(
				layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
					Layer.provide(Layer.mergeAll(eventsLayer(Effect.void), editLockLayer)),
				),
			),
		);
	}
	const fixture = yield* tokenSession;
	const { auth, sql, lock, grant, proof, advance, now } = fixture;
	const operation = Effect.gen(function* () {
		const original = yield* grant();
		const originalRow = (yield* sql`SELECT id FROM tokens WHERE family=${original.family} AND kind='refresh'`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))),
		))[0];
		assert.ok(originalRow);
		if (
			scenario === "rotation" ||
			scenario === "persist" ||
			scenario === "crash-before" ||
			scenario === "crash-after"
		) {
			if (scenario === "crash-before")
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* auth.refreshTokens(original.refresh, "retry");
						yield* Console.log("UNCOMMITTED");
						return yield* Effect.never;
					}),
				);
			const pairs = yield* Effect.all(
				[
					auth.refreshTokens(original.refresh, "retry"),
					auth.refreshTokens(original.refresh, "retry"),
					auth.refreshTokens(original.refresh, "different"),
				],
				{ concurrency: "unbounded" },
			);
			const rotated = pairs[0];
			assert.ok(rotated);
			assert.deepEqual(pairs, [rotated, rotated, rotated]);
			assert.equal((yield* sql`SELECT * FROM tokens`).length, 4);
			assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.refreshed'`).length, 1);
			if (scenario === "rotation") {
				assert.equal(rotated.expires_at - now(), 86_400_000);
				assert.equal(rotated.refresh_expires_at - now(), 2_592_000_000);
			}
			assert.equal((yield* auth.authenticateAccess(original.access)).id, original.family);
			const storage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
				yield* sql`SELECT * FROM tokens`,
				yield* sql`SELECT * FROM refresh_receipts`,
				yield* sql`SELECT * FROM events`,
			]);
			for (const secret of [original.access, original.refresh, rotated.access, rotated.refresh])
				assert.ok(!storage.includes(secret));
			if (scenario === "persist" || scenario === "crash-after") {
				yield* fs.writeFileString(
					`${filename}.secrets`,
					yield* Schema.encodeEffect(Schema.fromJsonString(saved))({ original, rotated }),
					{ mode: 0o600 },
				);
				if (scenario === "crash-after") {
					yield* Console.log("COMMITTED");
					return yield* Effect.never;
				}
				return;
			}
			yield* fails(auth.refreshTokens(rotated.refresh, "retry"), "idempotency_conflict");
			assert.deepEqual(
				yield* sql`SELECT last_used_at FROM tokens WHERE family=${original.family} AND id<>${originalRow.id} AND kind='refresh'`,
				[{ last_used_at: null }],
			);
			const next = yield* auth.refreshTokens(rotated.refresh, "next");
			assert.deepEqual(yield* auth.refreshTokens(original.refresh, "another"), rotated);
			assert.deepEqual(yield* auth.refreshTokens(rotated.refresh), next);
			yield* advance(59_999);
			assert.deepEqual(yield* auth.refreshTokens(original.refresh), rotated);
			yield* advance(1);
			yield* fails(auth.refreshTokens(original.refresh), "family_revoked");
			assert.equal((yield* sql`SELECT * FROM tokens WHERE revoked_at IS NULL`).length, 0);
			assert.equal((yield* sql`SELECT * FROM refresh_receipts`).length, 0);
			assert.equal((yield* sql`SELECT * FROM refresh_idempotency`).length, 0);
		} else if (scenario === "reuse") {
			const rotated = yield* auth.refreshTokens(original.refresh, "cleanup-key");
			yield* advance(60_000);
			yield* auth.authenticateAccess(original.access);
			assert.equal((yield* sql`SELECT * FROM refresh_receipts`).length, 0);
			assert.equal((yield* sql`SELECT * FROM refresh_idempotency`).length, 0);
			assert.equal((yield* sql`SELECT * FROM tokens`).length, 4);
			yield* fails(auth.refreshTokens(original.refresh), "refresh_invalid");
			assert.equal((yield* sql`SELECT * FROM tokens WHERE revoked_at IS NOT NULL`).length, 0);
			// A newer live binding cannot mask theft detection on the old predecessor.
			yield* auth.refreshTokens(rotated.refresh, "later-key");
			yield* fails(auth.refreshTokens(original.refresh, "later-key"), "family_revoked");
			const second = yield* grant();
			const successor = yield* auth.refreshTokens(second.refresh);
			yield* auth.authenticateAccess(successor.access);
			yield* sql`UPDATE tokens SET expires_at=${now()} WHERE family=${second.family} AND kind='refresh' AND rotated_to IS NOT NULL`;
			yield* fails(auth.refreshTokens(second.refresh), "refresh_invalid");
			assert.equal(
				(yield* sql`SELECT * FROM tokens WHERE family=${second.family} AND revoked_at IS NOT NULL`).length,
				0,
			);
			// Used access evidence remains meaningful after the access expires.
			const third = yield* grant();
			const thirdNext = yield* auth.refreshTokens(third.refresh);
			yield* auth.authenticateAccess(thirdNext.access);
			yield* advance(86_400_001);
			yield* fails(auth.refreshTokens(third.refresh), "family_revoked");
			const longLived = yield* grant(true),
				longNext = yield* auth.refreshTokens(longLived.refresh);
			assert.equal(longNext.expires_at - now(), 604_800_000);
			assert.equal(longNext.refresh_expires_at - now(), 7_776_000_000);
		} else if (scenario === "corruption") {
			const rotated = yield* auth.refreshTokens(original.refresh);
			const before = yield* sql`SELECT * FROM refresh_receipts`;
			for (const change of [
				"tag='AAAA'",
				"salt='AAAA'",
				"ciphertext='AAAA'",
				"nonce='AAAA'",
				"expires_at=expires_at+1",
				"successor_access_id='wrong'",
			]) {
				yield* sql.unsafe(`UPDATE refresh_receipts SET ${change}`);
				yield* fails(auth.refreshTokens(original.refresh));
				assert.equal((yield* sql`SELECT * FROM tokens`).length, 4);
				assert.equal((yield* sql`SELECT * FROM tokens WHERE revoked_at IS NOT NULL`).length, 0);
				yield* sql`DELETE FROM refresh_receipts`;
				for (const row of before) yield* sql`INSERT INTO refresh_receipts ${sql.insert(row)}`;
			}
			yield* sql`UPDATE tokens SET hash='bad' WHERE id=(SELECT successor_access_id FROM refresh_receipts)`;
			yield* fails(auth.refreshTokens(original.refresh));
			yield* sql`DELETE FROM refresh_receipts`;
			yield* fails(auth.refreshTokens(original.refresh));
			assert.equal((yield* sql`SELECT * FROM tokens`).length, 4);
			assert.ok(rotated.access);
		} else if (scenario === "rollback") {
			for (const table of ["refresh_receipts", "refresh_idempotency", "events"]) {
				yield* sql.unsafe(
					`CREATE TRIGGER refuse_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'storage failure'); END`,
				);
				yield* fails(auth.refreshTokens(original.refresh, "key"));
				assert.equal((yield* sql`SELECT * FROM tokens`).length, 2);
				assert.deepEqual(yield* sql`SELECT rotated_to,last_used_at FROM tokens WHERE id=${originalRow.id}`, [
					{ rotated_to: null, last_used_at: null },
				]);
				assert.equal((yield* sql`SELECT * FROM refresh_receipts`).length, 0);
				assert.equal((yield* sql`SELECT * FROM refresh_idempotency`).length, 0);
				yield* sql`DROP TRIGGER refuse_write`;
			}
			const acquired = yield* lock.acquire(original.family, "codex"),
				owner = { id: acquired.value.id, family: original.family };
			yield* lock.stage(owner, "app/test.ts", new TextEncoder().encode("retained"));
			const signed = yield* proof(original.family);
			yield* sql`CREATE TRIGGER refuse_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'storage failure'); END`;
			yield* fails(auth.revokeFamily({ family: original.family }, signed));
			assert.equal((yield* sql`SELECT * FROM tokens WHERE revoked_at IS NOT NULL`).length, 0);
			assert.equal((yield* lock.overlay(owner)).value.length, 1);
			assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${signed.id}`).length, 1);
			yield* sql`DROP TRIGGER refuse_event`;
			yield* auth.revokeFamily({ family: original.family }, signed);
			assert.equal((yield* sql`SELECT * FROM edit_lock`).length, 0);
			assert.equal((yield* sql`SELECT * FROM staging`).length, 0);
		} else if (scenario === "revoke") {
			const rotated = yield* auth.refreshTokens(original.refresh);
			const signed = yield* proof(original.family);
			yield* fails(auth.revokeFamily({ family: `f_${"z".repeat(43)}` }, signed), "challenge_invalid");
			const login = yield* auth.startLogin;
			yield* fails(
				auth.revokeFamily(
					{ family: original.family },
					{ id: login.id, response: fixture.device.assertion(login.options.challenge, 10) },
				),
				"challenge_invalid",
			);
			for (const response of [
				fixture.device.assertion(signed.challenge, 10, "https://evil.test"),
				fixture.device.assertion(signed.challenge, 10, undefined, "evil.test"),
				fixture.device.assertion(signed.challenge, 10, undefined, undefined, false),
			])
				yield* fails(
					auth.revokeFamily({ family: original.family }, { id: signed.id, response }),
					"authentication_invalid",
				);
			const acquired = yield* lock.acquire(original.family, "codex"),
				owner = { id: acquired.value.id, family: original.family };
			yield* lock.stage(owner, "app/test.ts", new TextEncoder().encode("pending"));
			yield* lock.pin(owner);
			const outcomes = yield* Effect.all(
				[
					auth.authenticateAccess(rotated.access).pipe(Effect.result),
					auth.revokeFamily({ family: original.family }, signed).pipe(Effect.result),
				],
				{ concurrency: "unbounded" },
			);
			assert.ok(Result.isSuccess(outcomes[1]));
			yield* fails(auth.authenticateAccess(rotated.access), "token_invalid");
			yield* fails(auth.refreshTokens(original.refresh), "family_revoked");
			assert.equal((yield* lock.inspect).value?.pending_release, "revoked");
			assert.equal((yield* lock.overlay(owner)).value.length, 1);
			yield* fails(auth.revokeFamily({ family: original.family }, signed), "challenge_invalid");
			yield* auth.revokeFamily({ family: original.family }, yield* proof(original.family));
			assert.equal(
				(yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.family_revoked'`).length,
				1,
			);
			yield* lock.finish(owner, { succeeded: false });
			assert.equal((yield* lock.inspect).value, null);
			const missing = `f_${"z".repeat(43)}`,
				missingProof = yield* proof(missing);
			yield* fails(auth.revokeFamily({ family: missing }, missingProof), "family_not_found");
			assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${missingProof.id}`).length, 0);
		} else if (scenario === "migration") {
			const tables = [
				"tokens",
				"enrollments",
				"passkeys",
				"sessions",
				"auth_challenges",
				"edit_lock",
				"staging",
				"source_batches",
				"source_changes",
				"seq",
				"events",
				"event_batches",
			];
			const before: unknown[] = [];
			for (const table of tables)
				before.push(
					yield* sql.unsafe(`SELECT ${table === "sessions" ? "id,hash,created_at,expires_at" : "*"} FROM ${table}`),
				);
			yield* sql`DROP TABLE mint_receipts`;
			yield* sql`DROP TABLE refresh_receipts`;
			yield* sql`DROP TABLE refresh_idempotency`;
			for (const table of ["child_attempts", "backups", "cutover"]) yield* sql.unsafe(`DROP TABLE ${table}`);
			yield* sql`ALTER TABLE sessions DROP COLUMN last_seen_at`;
			yield* sql`DROP TABLE public_paths`;
			yield* sql`DROP INDEX events_type_seq`;
			yield* sql`DROP INDEX events_actor_seq`;
			yield* sql`DROP INDEX events_instance_seq`;
			yield* sql`DROP INDEX events_level_seq`;
			yield* sql`DROP INDEX events_topic_seq`;
			yield* sql`ALTER TABLE events DROP COLUMN type`;
			yield* sql`ALTER TABLE events DROP COLUMN actor`;
			yield* sql`ALTER TABLE events DROP COLUMN instance`;
			yield* sql`ALTER TABLE events DROP COLUMN level`;
			yield* sql`ALTER TABLE events DROP COLUMN topic`;
			yield* sql`DROP TABLE IF EXISTS topic_moves`;
			yield* sql`DROP TABLE IF EXISTS topic_page_moves`;
			yield* sql`DROP TABLE db_restore_requests`;
			yield* sql`ALTER TABLE generations DROP COLUMN backup_id`;
			yield* sql`ALTER TABLE source_changes DROP COLUMN before_directory`;
			yield* sql`ALTER TABLE source_changes DROP COLUMN desired_directory`;
			yield* sql`ALTER TABLE versions DROP COLUMN previous_directory`;
			yield* sql`ALTER TABLE versions DROP COLUMN directory`;
			yield* sql`ALTER TABLE edit_lock DROP COLUMN reset_pin`;
			yield* sql`DROP TABLE IF EXISTS boot_migrations`;
			yield* sql`PRAGMA user_version=7`;
			yield* initializeBootSchema;
			const after: unknown[] = [];
			for (const table of tables)
				after.push(
					yield* sql.unsafe(`SELECT ${table === "sessions" ? "id,hash,created_at,expires_at" : "*"} FROM ${table}`),
				);
			assert.deepEqual(after, before);
			assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 18 }]);
			yield* auth.refreshTokens(original.refresh);
		}
	});
	return yield* scenario === "persist" || scenario?.startsWith("crash-")
		? operation
		: operation.pipe(Effect.provideService(Clock.Clock, fixture.clock));
});
await Effect.runPromise(
	run.pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename, disableWAL: true }), BunServices.layer)),
	),
);
await Effect.runPromise(Console.log("token scenario passed"));
