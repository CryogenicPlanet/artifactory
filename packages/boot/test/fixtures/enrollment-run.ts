import { layer as durableEventsLayer } from "../../src/events.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import type { EnrollmentDecision } from "../../src/enrollment-schema.ts";
import { layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { authenticator } from "./authenticator.ts";

const editLockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient,
		fs = yield* FileSystem.FileSystem;
	yield* initializeBootSchema;
	if (scenario === "migration") {
		yield* sql`DROP TABLE mint_receipts`;
		yield* sql`DROP TABLE refresh_receipts`;
		yield* sql`DROP TABLE refresh_idempotency`;
		yield* sql`DROP TABLE tokens`;
		yield* sql`DROP TABLE enrollments`;
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
		yield* sql`PRAGMA user_version=6`;
		yield* sql`INSERT INTO passkeys VALUES('saved','public-key',4,'[]','label',12)`;
		yield* sql`INSERT INTO sessions(id,hash,created_at,expires_at) VALUES('session','hash',1,9999999999999)`;
		yield* sql`INSERT INTO auth_challenges VALUES('challenge','signed','login',NULL,9999999999999)`;
		yield* sql`INSERT INTO edit_lock(singleton,id,holder_family,agent,since,expires,ttl_seconds,note) VALUES(1,'lock','family','codex',0,9999999999999,900,'unfinished')`;
		yield* sql`INSERT INTO staging VALUES('lock','app/x.ts',X'6566','stage',2,493)`;
		yield* sql`INSERT INTO source_batches VALUES('pending','lock','codex',1,'publishing')`;
		yield* sql`INSERT INTO source_changes VALUES('pending','app/x.ts',X'6162','before',493,X'6364','after',420)`;
		yield* sql`UPDATE seq SET next=3,pending_id='tx',pending_attempt='attempt',pending_from=1,pending_to=2`;
		yield* sql`INSERT INTO event_batches VALUES('tx','attempt',1,2,'pending')`;
		const tables = [
			"passkeys",
			"sessions",
			"auth_challenges",
			"edit_lock",
			"staging",
			"source_batches",
			"source_changes",
			"seq",
			"event_batches",
		];
		const before: unknown[] = [];
		for (const table of tables)
			before.push(
				yield* sql.unsafe(
					`SELECT ${table === "sessions" ? "id,hash,created_at,expires_at" : table === "edit_lock" ? "singleton,id,holder_family,agent,since,expires,ttl_seconds,note,cutover_in_flight,pending_release" : table === "source_changes" ? "batch,path,before,before_sha,before_mode,desired,desired_sha,desired_mode" : "*"} FROM ${table}`,
				),
			);

		yield* initializeBootSchema;
		const after: unknown[] = [];
		for (const table of tables)
			after.push(
				yield* sql.unsafe(
					`SELECT ${table === "sessions" ? "id,hash,created_at,expires_at" : table === "edit_lock" ? "singleton,id,holder_family,agent,since,expires,ttl_seconds,note,cutover_in_flight,pending_release" : table === "source_changes" ? "batch,path,before,before_sha,before_mode,desired,desired_sha,desired_mode" : "*"} FROM ${table}`,
				),
			);
		assert.deepEqual(after, before);
		assert.deepEqual(yield* sql`SELECT before_directory,desired_directory FROM source_changes`, [
			{ before_directory: 0, desired_directory: 0 },
		]);
		assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 18 }]);
		assert.equal((yield* sql`SELECT * FROM tokens`).length, 0);
		assert.equal((yield* sql`SELECT * FROM enrollments`).length, 0);
		return;
	}
	const output: string[] = [];
	const captured: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const restart = () =>
		Layer.build(
			layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
				Layer.provide(Layer.mergeAll(eventsLayer(Effect.void), editLockLayer)),
			),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
	const auth = yield* restart();
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, code?: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result));
				if (code)
					assert.ok(
						typeof result.failure === "object" &&
							result.failure !== null &&
							"code" in result.failure &&
							result.failure.code === code,
					);
			}),
		);
	if (scenario === "resume") {
		const receipt = yield* Schema.decodeEffect(
			Schema.fromJsonString(
				Schema.Struct({ id: Schema.String, secret: Schema.String, access: Schema.String, family: Schema.String }),
			),
		)(yield* fs.readFileString(`${filename}.receipt`));
		assert.equal((yield* auth.authenticateAccess(receipt.access)).id, receipt.family);
		yield* fails(auth.collectEnrollment(receipt.id, receipt.secret), "already_collected");
		return;
	}
	const device = authenticator();
	const setup = yield* auth.startSetup(output[0]?.split("code ")[1] ?? "");
	yield* auth.finishSetup(setup.id, device.registration(setup.options.challenge));
	const enrollment = yield* auth.createEnrollment({ name: "codex", kind: "codex", host: "laptop" });
	const params: EnrollmentDecision = {
		id: enrollment.id,
		decision: "approve",
		scopes: ["read", "write"],
		long_lived: false,
	};
	const proof = (input = params, counter = 1) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startEnrollmentAssertion(input);
			return {
				id: challenge.id,
				response: device.assertion(challenge.options.challenge, counter),
				challenge: challenge.options.challenge,
			};
		});
	if (scenario === "proof") {
		const signed = yield* proof();
		for (const changed of [
			{ ...params, id: `e_${"a".repeat(43)}` },
			{ ...params, scopes: ["read"] as const },
			{ ...params, long_lived: true },
			{ ...params, decision: "deny" as const, scopes: [] },
		])
			yield* fails(auth.decideEnrollment(changed, signed), "challenge_invalid");
		for (const response of [
			device.assertion(signed.challenge, 1, "https://evil.test"),
			device.assertion(signed.challenge, 1, undefined, "evil.test"),
			device.assertion(signed.challenge, 1, undefined, undefined, false),
		])
			yield* fails(auth.decideEnrollment(params, { id: signed.id, response }), "authentication_invalid");
		const login = yield* auth.startLogin;
		yield* fails(
			auth.decideEnrollment(params, { id: login.id, response: device.assertion(login.options.challenge) }),
			"challenge_invalid",
		);
		const outcomes = yield* Effect.all(
			[
				auth.decideEnrollment({ ...params, scopes: ["write", "read"] }, signed).pipe(Effect.result),
				auth.decideEnrollment(params, signed).pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(outcomes.filter(Result.isSuccess).length, 1);
		assert.equal((yield* sql`SELECT * FROM events`).length, 1);
		const expired = yield* proof(params, 2);
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${expired.id}`;
		yield* fails(auth.decideEnrollment(params, expired), "challenge_invalid");
		const stale = yield* proof(params, 1);
		yield* fails(auth.decideEnrollment(params, stale), "authentication_invalid");
		const terminal = yield* proof(params, 2);
		yield* fails(auth.decideEnrollment(params, terminal), "enrollment_decided");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${terminal.id}`).length, 0);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 2 }]);
		assert.equal((yield* sql`SELECT * FROM sessions`).length, 0);
	} else if (scenario === "rollback") {
		const signed = yield* proof();
		yield* sql`CREATE TRIGGER refuse_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'disk failure'); END`;
		yield* fails(auth.decideEnrollment(params, signed));
		assert.equal((yield* auth.enrollmentInfo(enrollment.id)).status, "pending");
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${signed.id}`).length, 1);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 0 }]);
		yield* sql`DROP TRIGGER refuse_event`;
		yield* auth.decideEnrollment(params, signed);
		yield* sql`CREATE TRIGGER refuse_refresh BEFORE INSERT ON tokens WHEN NEW.kind='refresh' BEGIN SELECT RAISE(ABORT,'disk failure'); END`;
		yield* fails(auth.collectEnrollment(enrollment.id, enrollment.device_secret));
		assert.equal((yield* sql`SELECT * FROM tokens`).length, 0);
		assert.equal((yield* auth.enrollmentInfo(enrollment.id)).status, "approved");
		yield* sql`DROP TRIGGER refuse_refresh`;
		const pair = yield* auth.collectEnrollment(enrollment.id, enrollment.device_secret);
		assert.equal(pair.status, "collected");
	} else if (scenario === "collection") {
		assert.deepEqual(yield* auth.collectEnrollment(enrollment.id, enrollment.device_secret), {
			status: "pending",
			expires_at: enrollment.expires_at,
		});
		yield* fails(auth.collectEnrollment(enrollment.id, enrollment.user_code), "device_secret_invalid");
		yield* auth.decideEnrollment(params, yield* proof());
		const again = yield* restart();
		const results = yield* Effect.all(
			[
				again.collectEnrollment(enrollment.id, enrollment.device_secret).pipe(Effect.result),
				auth.collectEnrollment(enrollment.id, enrollment.device_secret).pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(results.filter(Result.isSuccess).length, 1);
		const pair = results.find(Result.isSuccess)?.success;
		assert.ok(pair && pair.status === "collected");
		assert.equal(pair.expires_at - (yield* Clock.currentTimeMillis) > 86_390_000, true);
		assert.equal(Buffer.from(pair.access, "base64url").length, 32);
		assert.equal(Buffer.from(pair.refresh, "base64url").length, 32);
		yield* fails(auth.authenticateAccess(pair.refresh), "token_invalid");
		const identity = yield* auth.authenticateAccess(pair.access);
		assert.equal(identity.agent, "codex");
		assert.equal(identity.kind, "agent");
		assert.equal(identity.id, pair.family);
		assert.deepEqual(identity.scopes, ["read", "write"]);
		const storage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
			yield* sql`SELECT * FROM tokens`,
			yield* sql`SELECT * FROM enrollments`,
			yield* sql`SELECT * FROM events`,
		]);
		for (const secret of [pair.access, pair.refresh, enrollment.device_secret]) {
			assert.ok(!storage.includes(secret));
			assert.ok(!output.join("\n").includes(secret));
		}
		assert.equal((yield* sql`SELECT DISTINCT pair_id FROM tokens`).length, 1);
		yield* fs.writeFileString(
			`${filename}.receipt`,
			yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
				id: enrollment.id,
				secret: enrollment.device_secret,
				access: pair.access,
				family: pair.family,
			}),
			{ mode: 0o600 },
		);
	} else if (scenario === "legacy-label") {
		yield* sql`UPDATE enrollments SET host='Legacy-Host' WHERE id=${enrollment.id}`;
		assert.equal((yield* auth.enrollmentInfo(enrollment.id)).host, "Legacy-Host");
		yield* auth.decideEnrollment(params, yield* proof());
		const pair = yield* auth.collectEnrollment(enrollment.id, enrollment.device_secret);
		assert.ok(pair.status === "collected");
		assert.equal(pair.label, "Legacy-Host");
		assert.equal((yield* auth.authenticateAccess(pair.access)).label, "Legacy-Host");
		assert.equal((yield* auth.refreshTokens(pair.refresh)).label, "Legacy-Host");
	} else if (scenario === "denial") {
		const deny: EnrollmentDecision = { ...params, decision: "deny", scopes: [] };
		yield* fails(auth.startEnrollmentAssertion({ ...deny, scopes: ["fs"] }), "invalid_request");
		yield* auth.decideEnrollment(deny, yield* proof(deny));
		yield* fails(auth.collectEnrollment(enrollment.id, enrollment.device_secret), "enrollment_denied");
		const expired = yield* auth.createEnrollment({ name: "claude", kind: "claude", host: "laptop" });
		yield* sql`UPDATE enrollments SET expires_at=0 WHERE id=${expired.id}`;
		yield* fails(auth.collectEnrollment(expired.id, expired.device_secret), "enrollment_expired");
		assert.equal((yield* sql`SELECT * FROM tokens`).length, 0);
		for (const host of ["Uppercase", "host/name", "a".repeat(65), "", ".host"])
			yield* fails(auth.createEnrollment({ name: "codex", kind: "codex", host }), "invalid_request");
		const valid = yield* auth.createEnrollment({ name: "codex", kind: "codex", host: "a".repeat(64) });
		assert.equal((yield* auth.enrollmentInfo(valid.id)).host, "a".repeat(64));
		for (const name of ["rahul", "boot", "Bad Name"])
			yield* fails(auth.createEnrollment({ name, kind: "codex", host: "laptop" }), "invalid_request");
	}
});
await Effect.runPromise(
	run.pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename, disableWAL: true }), BunServices.layer)),
	),
);
await Effect.runPromise(Console.log("enrollment scenario passed"));
