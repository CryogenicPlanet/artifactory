/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { authentication } from "../../src/auth-http.ts";
import { AddPasskey } from "../../src/passkey-management-schema.ts";
import { authenticator } from "./authenticator.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const output: string[] = [];
	const captured: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const restart = () =>
		Layer.build(
			authLayer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
				Layer.provide(Layer.mergeAll(lockLayer, eventsLayer(Effect.void))),
			),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
	const auth = yield* restart();
	const fs = yield* FileSystem.FileSystem;
	const persistedInput = Schema.Struct({ params: AddPasskey, proof: authentication, sessionId: Schema.String });
	const persisted = Schema.fromJsonString(persistedInput);
	if (scenario === "resume-process") {
		const saved = yield* Schema.decodeEffect(persisted)(yield* fs.readFileString(`${filename}.registration`));
		yield* auth.finishPasskeyRegistration(saved.params, saved.proof, saved.sessionId);
		assert.equal((yield* auth.listPasskeys(saved.sessionId)).items.length, 2);
		assert.equal((yield* sql`SELECT id FROM sessions`).length, 1);
		return;
	}
	const first = authenticator(),
		second = authenticator();
	const code = output.at(-1)?.split("code ")[1];
	assert.ok(code);
	const setup = yield* auth.startSetup(code);
	yield* auth.finishSetup(setup.id, first.registration(setup.options.challenge));
	const login = yield* auth.startLogin;
	const session = yield* auth.finishLogin(login.id, first.assertion(login.options.challenge, 1));
	let counter = 1;
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, code?: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result));
				if (code)
					assert.ok(
						result.failure &&
							typeof result.failure === "object" &&
							"code" in result.failure &&
							result.failure.code === code,
						`expected ${code}, got ${String(result.failure)}`,
					);
			}),
		);
	const start = yield* auth.startPasskeyRegistration("Hardware key", session.id);
	assert.deepEqual(
		start.options.excludeCredentials?.map((row) => row.id),
		[first.id],
	);
	const params: AddPasskey = {
		registration: start.id,
		label: "Hardware key",
		response: second.registration(start.options.challenge),
	};
	const proofFor = (input = params, id = session.id) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startPasskeyAddAssertion(input, id);
			assert.ok(challenge.options.allowCredentials?.some((row) => row.id === first.id));
			assert.ok(!challenge.options.allowCredentials?.some((row) => row.id === second.id));
			return { id: challenge.id, response: first.assertion(challenge.options.challenge, ++counter) };
		});
	if (scenario === "persist-process") {
		const saved = yield* Schema.decodeUnknownEffect(persistedInput)({
			params,
			proof: yield* proofFor(),
			sessionId: session.id,
		});
		yield* fs.writeFileString(`${filename}.registration`, yield* Schema.encodeEffect(persisted)(saved));
	} else if (scenario === "binding") {
		const proof = yield* proofFor();
		for (const changed of [
			{ ...params, label: "Other key" },
			{ ...params, registration: setup.id },
			{ ...params, response: authenticator().registration(start.options.challenge) },
			{ ...params, response: { ...params.response, rawId: first.id } },
			{ ...params, response: { ...params.response, response: { ...params.response.response, transports: ["usb"] } } },
		])
			yield* fails(auth.finishPasskeyRegistration(changed, proof, session.id), "challenge_invalid");
		yield* fails(auth.finishPasskeyRegistration(params, proof, "other-session"), "challenge_invalid");
		const cross = yield* auth.startLogin;
		yield* fails(
			auth.finishPasskeyRegistration(
				params,
				{ id: cross.id, response: first.assertion(cross.options.challenge, ++counter) },
				session.id,
			),
			"challenge_invalid",
		);
		// A new session cannot finish a pending registration created in an earlier session, even with its own valid proof.
		const anotherLogin = yield* auth.startLogin;
		const anotherSession = yield* auth.finishLogin(
			anotherLogin.id,
			first.assertion(anotherLogin.options.challenge, ++counter),
		);
		const anotherProof = yield* proofFor(params, anotherSession.id);
		yield* fails(auth.finishPasskeyRegistration(params, anotherProof, anotherSession.id), "challenge_invalid");
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
		const finalProof = yield* proofFor();
		yield* auth.finishPasskeyRegistration(params, finalProof, session.id);
		yield* fails(auth.finishPasskeyRegistration(params, finalProof, session.id), "challenge_invalid");
	} else if (scenario === "registration-validation") {
		for (const response of [
			second.registration(start.options.challenge, "https://evil.test"),
			second.registration(start.options.challenge, undefined, "evil.test"),
			second.registration(start.options.challenge, undefined, undefined, false),
			second.registration("wrong-challenge"),
		]) {
			const invalid = { ...params, response },
				proof = yield* proofFor(invalid);
			yield* fails(auth.finishPasskeyRegistration(invalid, proof, session.id), "registration_invalid");
			assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		}
		const expired = yield* proofFor();
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${start.id}`;
		yield* fails(auth.finishPasskeyRegistration(params, expired, session.id), "challenge_invalid");
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
	} else if (scenario === "assertion-validation") {
		const challenge = yield* auth.startPasskeyAddAssertion(params, session.id);
		for (const response of [
			first.assertion(challenge.options.challenge, 2, "https://evil.test"),
			first.assertion(challenge.options.challenge, 2, undefined, "evil.test"),
			first.assertion(challenge.options.challenge, 2, undefined, undefined, false),
		])
			yield* fails(
				auth.finishPasskeyRegistration(params, { id: challenge.id, response }, session.id),
				"authentication_invalid",
			);
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${challenge.id}`;
		yield* fails(
			auth.finishPasskeyRegistration(
				params,
				{ id: challenge.id, response: first.assertion(challenge.options.challenge, 2) },
				session.id,
			),
			"challenge_invalid",
		);
		const proof = yield* proofFor();
		yield* sql`DELETE FROM passkeys WHERE id=${first.id}`;
		yield* fails(auth.finishPasskeyRegistration(params, proof, session.id), "authentication_invalid");
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 0);
	} else if (scenario === "transaction-restart") {
		const proof = yield* proofFor();
		yield* sql`CREATE TRIGGER refuse_passkey BEFORE INSERT ON passkeys BEGIN SELECT RAISE(ABORT, 'disk failure'); END`;
		yield* fails(auth.finishPasskeyRegistration(params, proof, session.id));
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 1);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${start.id}`).length, 1);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 1 }]);
		yield* sql`DROP TRIGGER refuse_passkey`;
		const restarted = yield* restart();
		const results = yield* Effect.all(
			[
				restarted.finishPasskeyRegistration(params, proof, session.id).pipe(Effect.result),
				restarted.finishPasskeyRegistration(params, proof, session.id).pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(results.filter(Result.isSuccess).length, 1);
		assert.deepEqual(
			(yield* restarted.listPasskeys(session.id)).items.map((row) => Object.keys(row).sort()),
			[
				["created_at", "id", "label"],
				["created_at", "id", "label"],
			],
		);
		assert.equal((yield* sql`SELECT id FROM sessions`).length, 1);
		const newLogin = yield* restarted.startLogin;
		yield* restarted.finishLogin(newLogin.id, second.assertion(newLogin.options.challenge, 1));
		const challenge = yield* restarted.startPasskeyDeleteAssertion({ id: second.id }, session.id);
		const removeProof = { id: challenge.id, response: first.assertion(challenge.options.challenge, ++counter) };
		yield* sql`CREATE TRIGGER refuse_delete BEFORE DELETE ON passkeys BEGIN SELECT RAISE(ABORT, 'disk failure'); END`;
		yield* fails(restarted.deletePasskey({ id: second.id }, removeProof, session.id));
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${challenge.id}`).length, 1);
		yield* sql`DROP TRIGGER refuse_delete`;
		yield* restarted.deletePasskey({ id: second.id }, removeProof, session.id);
	} else if (scenario === "last-key") {
		yield* auth.finishPasskeyRegistration(params, yield* proofFor(), session.id);
		assert.equal((yield* auth.listPasskeys(session.id)).can_delete, true);
		const a = yield* auth.startPasskeyDeleteAssertion({ id: first.id }, session.id);
		const b = yield* auth.startPasskeyDeleteAssertion({ id: second.id }, session.id);
		const results = yield* Effect.all(
			[
				auth
					.deletePasskey(
						{ id: first.id },
						{ id: a.id, response: first.assertion(a.options.challenge, ++counter) },
						session.id,
					)
					.pipe(Effect.result),
				auth
					.deletePasskey(
						{ id: second.id },
						{ id: b.id, response: second.assertion(b.options.challenge, 1) },
						session.id,
					)
					.pipe(Effect.result),
			],
			{ concurrency: "unbounded" },
		);
		assert.equal(results.filter(Result.isSuccess).length, 1);
		const refusal = results.find(Result.isFailure);
		assert.ok(refusal && "code" in refusal.failure && refusal.failure.code === "last_passkey");
		assert.equal((yield* auth.listPasskeys(session.id)).can_delete, false);
		assert.equal(yield* auth.setupOpen, false);
	} else if (scenario === "late-session") {
		const proof = yield* proofFor();
		// Expiry after proof verification must still prevent the mutation; the proof is consumed.
		yield* sql`CREATE TRIGGER expire_session AFTER DELETE ON auth_challenges WHEN OLD.ceremony='passkey.add' BEGIN UPDATE sessions SET expires_at=0; END`;
		yield* fails(auth.finishPasskeyRegistration(params, proof, session.id), "session_invalid");
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${proof.id}`).length, 0);
		yield* sql`DROP TRIGGER expire_session`;
		yield* sql`UPDATE sessions SET expires_at=9999999999999 WHERE id=${session.id}`;
		yield* auth.finishPasskeyRegistration(params, yield* proofFor(), session.id);
		const remove = yield* auth.startPasskeyDeleteAssertion({ id: second.id }, session.id);
		const removeProof = { id: remove.id, response: first.assertion(remove.options.challenge, ++counter) };
		yield* auth.logout(session.token);
		yield* fails(auth.deletePasskey({ id: second.id }, removeProof, session.id), "session_invalid");
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 2);
	} else throw new Error("Unknown scenario");
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("passkey management passed"));
