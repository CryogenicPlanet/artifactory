/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Cause, Clock, Console, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AuthError } from "../../src/auth.ts";
import { authFailure, authentication, sessionCookie } from "../../src/auth-http.ts";
import { makeDatabaseRestoreAuth } from "../../src/database-restore-auth.ts";
import { DatabaseRestoreRequest } from "../../src/database-restore-schema.ts";
import { enrollmentRoute } from "../../src/enrollment-http.ts";
import { fails, tokenSession } from "./token-session.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const fixture = yield* tokenSession;
	const { auth, sql, device } = fixture;
	const login = yield* auth.startLogin;
	const session = yield* auth.finishLogin(login.id, device.assertion(login.options.challenge, 2));
	const backup = "00000000-0000-4000-8000-000000000001";
	const alternate = "00000000-0000-4000-8000-000000000002";
	yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES(${backup},'/private/backup','hourly',64,0,7)`;
	let counter = 2;
	const proofFor = (id = backup, owner = session.id, key?: string) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startDatabaseRestoreAssertion(
				{ backup: id, ...(key === undefined ? {} : { idempotency_key: key }) },
				owner,
			);
			return yield* Schema.decodeUnknownEffect(authentication)({
				id: challenge.id,
				response: device.assertion(challenge.options.challenge, ++counter),
			});
		});
	const authorize = (proof: typeof authentication.Type, id = backup, owner = session.id, key?: string) =>
		auth.authorizeDatabaseRestore({ backup: id, ...(key === undefined ? {} : { idempotency_key: key }) }, proof, owner);

	if (scenario === "foreign-engine") {
		for (const engine of ["pg", "mysql"]) {
			yield* sql`UPDATE backups SET engine=${engine}`;
			const proof = yield* proofFor();
			const response = yield* authFailure(authorize(proof).pipe(Effect.map(() => HttpServerResponse.empty())));
			assert.equal(response.status, 409);
			assert.equal(response.body._tag, "Uint8Array");
			if (response.body._tag === "Uint8Array")
				assert.equal(JSON.parse(new TextDecoder().decode(response.body.body)).error.code, "backup_engine_mismatch");
			assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 0);
			assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		}
		return;
	}

	if (scenario === "mixed-refusal") {
		const mutex = yield* Semaphore.make(1);
		const refusal = new AuthError({ code: "authentication_invalid" });
		const faults: readonly Effect.Effect<unknown, Schema.SchemaError | SqlError>[] = [
			Effect.die("verifier defect"),
			Schema.decodeUnknownEffect(Schema.Int)("bad"),
			sql`SELECT * FROM missing_auth_table`,
			Effect.interrupt,
			Effect.void,
		];
		for (const extra of faults) {
			const proof = yield* proofFor();
			const before = yield* sql`SELECT counter FROM passkeys`;
			const fault = yield* extra.pipe(Effect.exit);
			const cause = Exit.isFailure(fault) ? Cause.combine(Cause.fail(refusal), fault.cause) : Cause.fail(refusal);
			const authorizeRestore = yield* makeDatabaseRestoreAuth(
				() =>
					Effect.gen(function* () {
						// Simulate a verifier failing after its proof and counter writes.
						yield* sql`DELETE FROM auth_challenges WHERE id=${proof.id}`;
						yield* sql`UPDATE passkeys SET counter=counter+1`;
						return yield* Effect.failCause(cause);
					}),
				mutex,
			);
			const outcome = yield* authorizeRestore({ backup }, proof, session.id).pipe(Effect.exit);
			assert.ok(Exit.isFailure(outcome));
			const rollback = Exit.isFailure(fault);
			assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, rollback ? before : [{ counter: 3 }]);
			assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, rollback ? 1 : 0);
			assert.equal((yield* sql`SELECT proof_id FROM db_restore_requests`).length, 0);
			assert.deepEqual(outcome.cause.reasons, cause.reasons);
			yield* sql`DELETE FROM auth_challenges WHERE id=${proof.id}`;
		}
		return;
	}

	if (scenario?.startsWith("combined-")) {
		yield* sql`INSERT INTO generations(n,snapshot_dir,entry_file,status,good,started_at,backup_id)
 VALUES(1,'/private/source','main.ts','retired',1,0,${backup}), (2,'/private/other','main.ts','retired',1,0,${backup})`;
		const selection = { generation: 1, withDb: true, idempotency_key: "combined" } as const;
		const challenge = yield* auth.startGenerationRestoreAssertion(selection, session.id);
		const proof = yield* Schema.decodeUnknownEffect(authentication)({
			id: challenge.id,
			response: device.assertion(challenge.options.challenge, ++counter),
		});
		const combined = (input = selection, owner = session.id, value = proof) =>
			auth.authorizeDatabaseRestore(input, value, owner);
		if (scenario === "combined-http") {
			const request = (params: unknown, cookie = session.token, extra: Record<string, string> = {}) =>
				enrollmentRoute(auth, { rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(
							new Request("https://comms.test/_boot/auth/challenge", {
								method: "POST",
								headers: { origin: "https://comms.test", cookie: `${sessionCookie}=${cookie}`, ...extra },
								body: JSON.stringify({ action: "generation.restore", params }),
							}),
						),
					),
				);
			assert.equal((yield* request(selection))?.status, 200);
			for (const input of [
				{ generation: 1 },
				{ generation: 0, withDb: true },
				{ generation: 1.5, withDb: true },
				{ generation: Number.MAX_SAFE_INTEGER + 1, withDb: true },
				{ generation: 1, withDb: false },
				{ ...selection, backup },
				{ ...selection, path: "app/main.ts" },
				{ ...selection, idempotency_key: "" },
			])
				assert.equal((yield* request(input))?.status, 400);
			assert.equal((yield* request(selection, ""))?.status, 401);
			assert.equal((yield* request(selection, session.token, { authorization: "Bearer invalid" }))?.status, 401);
			assert.equal((yield* request(selection, session.token, { origin: "https://evil.test" }))?.status, 403);
			return;
		}
		if (scenario === "combined-late-session") {
			yield* sql`CREATE TRIGGER expire_during_proof AFTER UPDATE OF counter ON passkeys BEGIN UPDATE sessions SET expires_at=0; END`;
			yield* fails(combined(), "session_invalid");
			assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 0);
			assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 0);
			return;
		}
		if (scenario === "combined-binding") {
			yield* fails(
				auth.authorizeDatabaseRestore({ ...selection, generation: 2 }, proof, session.id),
				"challenge_invalid",
			);
			yield* fails(authorize(proof, backup, session.id, "combined"), "challenge_invalid");
			yield* fails(
				auth.authorizeDatabaseRestore({ ...selection, idempotency_key: "changed" }, proof, session.id),
				"challenge_invalid",
			);
			yield* fails(combined(selection, "other-session"), "session_invalid");
			yield* sql`UPDATE backups SET published_through=8 WHERE id=${backup}`;
			yield* fails(combined(), "challenge_invalid");
			yield* sql`UPDATE backups SET published_through=7 WHERE id=${backup}`;
			yield* sql`INSERT INTO backups(id,path,reason,bytes,taken_at,published_through) VALUES(${alternate},'/private/alternate','pre-flip',64,0,7)`;
			yield* sql`UPDATE generations SET backup_id=${alternate} WHERE n=1`;
			yield* fails(combined(), "challenge_invalid");
			yield* sql`UPDATE generations SET backup_id=${backup},good=0 WHERE n=1`;
			yield* fails(combined(), "generation_not_restorable");
			yield* sql`UPDATE generations SET good=1,snapshot_dir=NULL WHERE n=1`;
			yield* fails(combined(), "generation_not_restorable");
			yield* sql`UPDATE generations SET snapshot_dir='/private/source',backup_id=NULL WHERE n=1`;
			yield* fails(combined(), "backup_not_restorable");
			yield* sql`UPDATE generations SET backup_id=${backup} WHERE n=1`;
			const receipt = yield* combined();
			assert.equal(receipt.source_generation, 1);
			assert.equal(receipt.generation, null);
			assert.equal(receipt.backup, backup);
			assert.equal(receipt.restored_to_seq, 7);
			assert.equal(receipt.prior_generation, null);
			assert.equal(receipt.source_batch, null);
			return;
		}
		const receipt = yield* combined();
		yield* sql`UPDATE db_restore_requests SET phase='restored'`;
		// Catalog pruning cannot make a terminal receipt execute again or require a new proof.
		yield* sql`DELETE FROM backups`;
		yield* sql`UPDATE generations SET snapshot_dir=NULL,backup_id=NULL`;
		assert.equal((yield* combined()).phase, "restored");
		const unrelated = yield* proofFor(backup, session.id, "combined");
		assert.equal((yield* combined(selection, session.id, unrelated)).proof_id, receipt.proof_id);
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${unrelated.id}`).length, 1);
		yield* fails(authorize(unrelated, backup, session.id, "combined"), "idempotency_conflict");
		yield* fails(
			auth.authorizeDatabaseRestore({ ...selection, generation: 2 }, unrelated, session.id),
			"idempotency_conflict",
		);
		yield* fails(
			combined(selection, session.id, {
				...proof,
				response: { ...proof.response, response: { ...proof.response.response, signature: "AAAA" } },
			}),
			"assertion_invalid",
		);
		yield* auth.logout(session.token);
		yield* fails(combined(), "session_invalid");
		return;
	}
	if (scenario === "http-challenge") {
		const request = (params: unknown, cookie = session.token, extra: Record<string, string> = {}) =>
			enrollmentRoute(auth, { rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(
						new Request("https://comms.test/_boot/auth/challenge", {
							method: "POST",
							headers: { origin: "https://comms.test", cookie: `${sessionCookie}=${cookie}`, ...extra },
							body: JSON.stringify({ action: "db.restore", params }),
						}),
					),
				),
			);
		assert.equal((yield* request({ backup }))?.status, 200);
		assert.equal((yield* request({ id: backup }))?.status, 200);
		assert.equal((yield* request({ id: backup, idempotency_key: "retry" }))?.status, 200);
		assert.equal((yield* request({ backup, idempotency_key: "retry" }))?.status, 200);
		assert.equal((yield* request({ backup, idempotency_key: "" }))?.status, 400);
		assert.equal((yield* request({ backup, id: backup }))?.status, 400);
		assert.equal((yield* request({ backup: "../backup" }))?.status, 400);
		assert.equal((yield* request({ backup }, ""))?.status, 401);
		assert.equal((yield* request({ backup }, session.token, { authorization: "Bearer invalid" }))?.status, 401);
		assert.equal((yield* request({ backup }, session.token, { origin: "https://evil.test" }))?.status, 403);
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 0);
		return;
	}
	if (scenario === "idempotency") {
		const key = "restore-attempt";
		const original = yield* proofFor(backup, session.id, key);
		for (const invalid of ["", "x".repeat(129), "\n", "é"]) {
			yield* fails(proofFor(backup, session.id, invalid), "invalid_request");
			yield* fails(authorize(original, backup, session.id, invalid), "invalid_request");
		}
		yield* fails(authorize(original), "challenge_invalid");
		yield* fails(authorize(original, backup, session.id, "changed"), "challenge_invalid");
		const saved = yield* authorize(original, backup, session.id, key);
		assert.equal(saved.idempotency_key, key);
		yield* fails(authorize(original), "idempotency_conflict");
		yield* fails(authorize(original, backup, session.id, "changed"), "idempotency_conflict");
		const replacement = yield* proofFor(backup, session.id, key);
		const proofCounter = yield* sql`SELECT counter FROM passkeys`;
		assert.deepEqual(yield* authorize(replacement, backup, session.id, key), saved);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, proofCounter);
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${replacement.id}`).length, 1);
		yield* fails(authorize(replacement, alternate, session.id, key), "idempotency_conflict");
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 1);
		for (const phase of ["restored", "failed"]) {
			yield* sql`UPDATE db_restore_requests SET phase=${phase}`;
			assert.equal((yield* authorize(replacement, backup, session.id, key)).phase, phase);
		}
		const otherLogin = yield* auth.startLogin;
		const other = yield* auth.finishLogin(otherLogin.id, device.assertion(otherLogin.options.challenge, ++counter));
		const otherProof = yield* proofFor(backup, other.id, key);
		const otherSaved = yield* authorize(otherProof, backup, other.id, key);
		assert.equal(otherSaved.session_id, other.id);
		assert.notEqual(otherSaved.proof_id, saved.proof_id);
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 2);
		yield* auth.logout(session.token);
		yield* fails(authorize(replacement, backup, session.id, key), "session_invalid");
		return;
	}
	if (scenario === "binding") {
		const proof = yield* proofFor();
		yield* fails(authorize(proof, alternate), "challenge_invalid");
		yield* fails(authorize(proof, backup, "another-session"), "challenge_invalid");
		yield* fails(
			authorize({
				...proof,
				response: { ...proof.response, response: { ...proof.response.response, signature: "AAAA" } },
			}),
			"authentication_invalid",
		);
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		const request = yield* authorize(proof);
		assert.equal(request.phase, "authorized");
		assert.equal(request.restored_to_seq, 7);
		assert.equal(request.generation, null);
		return;
	}
	if (scenario === "semantic") {
		const missing = yield* proofFor(alternate);
		yield* fails(authorize(missing, alternate), "backup_not_found");
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${missing.id}`).length, 0);
		yield* sql`UPDATE backups SET published_through=NULL`;
		const legacy = yield* proofFor();
		yield* fails(authorize(legacy), "backup_not_restorable");
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${legacy.id}`).length, 0);
		yield* sql`UPDATE backups SET published_through=7`;
		const expired = yield* proofFor();
		yield* sql`CREATE TRIGGER expire_during_proof AFTER UPDATE OF counter ON passkeys BEGIN UPDATE sessions SET expires_at=0; END`;
		yield* fails(authorize(expired), "session_invalid");
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${expired.id}`).length, 0);
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 0);
		return;
	}
	if (scenario === "transaction") {
		const proof = yield* proofFor();
		const before = yield* sql`SELECT * FROM passkeys`;
		yield* sql`CREATE TRIGGER fail_receipt BEFORE INSERT ON db_restore_requests BEGIN SELECT RAISE(ABORT,'test storage failure'); END`;
		yield* fails(authorize(proof));
		assert.deepEqual(yield* sql`SELECT * FROM passkeys`, before);
		assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 0);
		yield* sql`DROP TRIGGER fail_receipt`;
		const [first, second] = yield* Effect.all([authorize(proof), authorize(proof)], { concurrency: "unbounded" });
		assert.deepEqual(first, second);
		assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 1);
		for (const phase of ["authorized", "restoring", "working", "rollback"]) {
			yield* sql`UPDATE db_restore_requests SET phase=${phase}`;
			const competing = yield* proofFor();
			yield* fails(authorize(competing), "restore_in_progress");
			assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${competing.id}`).length, 0);
		}
		return;
	}
	const proof = yield* proofFor();
	const receipt = yield* authorize(proof);
	yield* fixture.advance(120_001);
	assert.deepEqual(yield* authorize(proof).pipe(Effect.provideService(Clock.Clock, fixture.clock)), receipt);
	yield* fails(authorize(proof, alternate), "idempotency_conflict");
	yield* fails(
		authorize({
			...proof,
			response: { ...proof.response, response: { ...proof.response.response, signature: "AAAA" } },
		}),
		"assertion_invalid",
	);
	const secondLogin = yield* auth.startLogin;
	const other = yield* auth.finishLogin(secondLogin.id, device.assertion(secondLogin.options.challenge, ++counter));
	yield* fails(authorize(proof, backup, other.id), "assertion_invalid");
	for (const phase of ["restored", "failed"]) {
		yield* sql`UPDATE db_restore_requests SET phase=${phase}`;
		const row = (yield* sql`SELECT * FROM db_restore_requests`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DatabaseRestoreRequest))),
		))[0];
		assert.deepEqual(yield* authorize(proof), row);
	}
	yield* auth.logout(session.token);
	yield* fails(authorize(proof), "session_invalid");
	assert.equal((yield* sql`SELECT * FROM db_restore_requests`).length, 1);
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("database restore auth passed"));
