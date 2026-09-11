/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Effect, FileSystem, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { authentication } from "../../src/auth-http.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as editLockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { TokenPair } from "../../src/refresh-schema.ts";
import { MintBinding } from "../../src/token-mint-schema.ts";
import { fails, tokenSession } from "./token-session.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const saved = Schema.Struct({
	params: MintBinding,
	proof: authentication,
	session: Schema.Struct({ id: Schema.String, token: Schema.String }),
	pair: Schema.optionalKey(TokenPair),
});
const run = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const sql = yield* SqlClient.SqlClient;
	if (scenario === "resume-before" || scenario === "resume-after") {
		yield* initializeBootSchema;
		const data = yield* Schema.decodeEffect(Schema.fromJsonString(saved))(
			yield* fs.readFileString(`${filename}.secrets`),
		);
		return yield* Effect.gen(function* () {
			const auth = yield* Auth;
			if (scenario === "resume-before") {
				assert.equal((yield* sql`SELECT * FROM tokens`).length, 0);
				assert.equal((yield* sql`SELECT * FROM mint_receipts`).length, 0);
				assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${data.proof.id}`).length, 1);
				assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 2 }]);
				assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.minted'`).length, 0);
			}
			const pair = yield* auth.mintTokens(data.params, data.proof, data.session.id, data.session.token);
			if (data.pair) assert.deepEqual(pair, data.pair);
			assert.deepEqual(yield* auth.mintTokens(data.params, data.proof, data.session.id, data.session.token), pair);
			assert.equal((yield* sql`SELECT * FROM tokens`).length, 2);
			assert.equal((yield* sql`SELECT * FROM mint_receipts`).length, 1);
			assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 3 }]);
			assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.minted'`).length, 1);
		}).pipe(
			Effect.provide(
				layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
					Layer.provide(Layer.mergeAll(eventsLayer, editLockLayer)),
				),
			),
		);
	}
	const fixture = yield* tokenSession;
	const { auth, device } = fixture;
	const login = yield* auth.startLogin;
	const session = yield* auth.finishLogin(login.id, device.assertion(login.options.challenge, 2));
	const params: MintBinding = {
		agent: "codex",
		label: "durability",
		scopes: ["read", "write", "fs"],
		long_lived: false,
		...(scenario === "natural-retry" ? {} : { idempotency_key: "retry" }),
	};
	const started = yield* auth.startMintAssertion(params);
	const proof = yield* Schema.decodeUnknownEffect(authentication)({
		id: started.id,
		response: device.assertion(started.options.challenge, 3),
	});
	const mint = auth
		.mintTokens(params, proof, session.id, session.token)
		.pipe(Effect.provideService(Clock.Clock, fixture.clock));
	if (scenario === "crash-before" || scenario === "crash-after") {
		yield* fs.writeFileString(
			`${filename}.secrets`,
			yield* Schema.encodeEffect(Schema.fromJsonString(saved))({ params, proof, session }),
			{ mode: 0o600 },
		);
		if (scenario === "crash-before")
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* mint;
					yield* Console.log("UNCOMMITTED");
					return yield* Effect.never;
				}),
			);
		const pair = yield* mint;
		yield* fs.writeFileString(
			`${filename}.secrets`,
			yield* Schema.encodeEffect(Schema.fromJsonString(saved))({ params, proof, session, pair }),
			{ mode: 0o600 },
		);
		yield* Console.log("COMMITTED");
		return yield* Effect.never;
	}
	if (scenario === "rollback") {
		const passkeys = yield* sql`SELECT * FROM passkeys`;
		const sessions = yield* sql`SELECT * FROM sessions`;
		const challenge = yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`;
		const sequence = yield* sql`SELECT * FROM seq`;
		for (const table of ["tokens", "mint_receipts", "events", "session-expiry"]) {
			// Fail the second token insert, after the first token and proof changes exist.
			if (table === "session-expiry")
				yield* sql`CREATE TRIGGER refuse_write BEFORE INSERT ON events BEGIN UPDATE sessions SET expires_at=0; END`;
			else
				yield* sql.unsafe(
					`CREATE TRIGGER refuse_write BEFORE INSERT ON ${table} ${table === "tokens" ? "WHEN NEW.kind='refresh'" : ""} BEGIN SELECT RAISE(ABORT,'storage failure'); END`,
				);
			yield* fails(mint, table === "session-expiry" ? "session_invalid" : undefined);
			assert.equal((yield* sql`SELECT * FROM tokens`).length, 0);
			assert.equal((yield* sql`SELECT * FROM mint_receipts`).length, 0);
			assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.minted'`).length, 0);
			assert.deepEqual(yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`, challenge);
			assert.deepEqual(yield* sql`SELECT * FROM passkeys`, passkeys);
			assert.deepEqual(yield* sql`SELECT * FROM sessions`, sessions);
			assert.deepEqual(yield* sql`SELECT * FROM seq`, sequence);
			yield* sql`DROP TRIGGER refuse_write`;
		}
	}
	const pairs = yield* Effect.all([mint, mint, mint], { concurrency: "unbounded" });
	const pair = pairs[0];
	assert.ok(pair);
	assert.deepEqual(pairs, [pair, pair, pair]);
	assert.equal((yield* sql`SELECT * FROM tokens`).length, 2);
	assert.equal((yield* sql`SELECT * FROM mint_receipts`).length, 1);
	assert.equal((yield* sql`SELECT * FROM auth_challenges WHERE id=${proof.id}`).length, 0);
	assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: 3 }]);
	assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.minted'`).length, 1);
	const storage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
		yield* sql`SELECT * FROM tokens`,
		yield* sql`SELECT * FROM mint_receipts`,
		yield* sql`SELECT * FROM events`,
		yield* sql`SELECT * FROM sessions`,
	]);
	for (const secret of [pair.access, pair.refresh, session.token]) assert.ok(!storage.includes(secret));
	assert.deepEqual(yield* sql`SELECT last_used_at FROM tokens`, [{ last_used_at: null }, { last_used_at: null }]);
	if (scenario === "corruption") {
		const before = yield* sql`SELECT * FROM mint_receipts`;
		for (const change of [
			"tag='AAAA'",
			"salt='AAAA'",
			"ciphertext='AAAA'",
			"nonce='AAAA'",
			"expires_at=expires_at+1",
			"family='wrong'",
			"successor_access_id='wrong'",
		]) {
			yield* sql.unsafe(`UPDATE mint_receipts SET ${change}`);
			yield* fails(mint);
			assert.equal((yield* sql`SELECT * FROM tokens`).length, 2);
			assert.equal((yield* sql`SELECT * FROM events WHERE json_extract(event,'$.type')='token.minted'`).length, 1);
			yield* sql`DELETE FROM mint_receipts`;
			for (const row of before) yield* sql`INSERT INTO mint_receipts ${sql.insert(row)}`;
		}
		yield* sql`UPDATE tokens SET hash='bad' WHERE kind='access'`;
		yield* fails(mint);
		yield* sql`DELETE FROM mint_receipts`;
		yield* fails(mint, "challenge_invalid");
		assert.equal((yield* sql`SELECT * FROM tokens`).length, 2);
	} else {
		// A consumed proof's original two-minute challenge TTL does not shorten its receipt.
		yield* fixture.advance(120_001);
		assert.deepEqual(yield* mint, pair);
		yield* fails(
			auth.mintTokens({ ...params, label: "changed" }, proof, session.id, session.token),
			"idempotency_conflict",
		);
	}
});
await Effect.runPromise(
	run.pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename, disableWAL: true }), BunServices.layer)),
	),
);
await Effect.runPromise(Console.log("mint scenario passed"));
