/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Cause, Console, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { makePasskeyManagement } from "../../src/passkey-management.ts";
import type { AssertionProof } from "../../src/enrollment.ts";

const filename = process.argv[2];
if (!filename) throw new Error("Missing database");
const proof: AssertionProof = {
	id: "proof",
	response: {
		id: "key",
		rawId: "key",
		type: "public-key",
		clientExtensionResults: {},
		response: { clientDataJSON: "", authenticatorData: "", signature: "" },
	},
};
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	yield* sql`INSERT INTO passkeys(id,public_key,counter,transports,label,created_at) VALUES('key','public-key',0,'[]','key',0)`;
	const mutex = yield* Semaphore.make(1);
	const refusal = new AuthError({ code: "authentication_invalid" });
	// The verifier seam simulates a late failure after consuming the proof and updating its counter.
	const faults: readonly Effect.Effect<unknown, unknown>[] = [
		Effect.die("verifier defect"),
		Schema.decodeUnknownEffect(Schema.Int)("bad"),
		sql`SELECT * FROM missing_auth_table`,
		Effect.interrupt,
		Effect.void,
	];
	for (const extra of faults) {
		yield* sql`INSERT INTO auth_challenges VALUES('proof','challenge','login',NULL,9999999999999)`;
		const fault = yield* extra.pipe(Effect.exit);
		const cause = Exit.isFailure(fault) ? Cause.combine(Cause.fail(refusal), fault.cause) : Cause.fail(refusal);
		const passkeys = yield* makePasskeyManagement(
			() =>
				Effect.gen(function* () {
					yield* sql`DELETE FROM auth_challenges WHERE id='proof'`;
					yield* sql`UPDATE passkeys SET counter=counter+1 WHERE id='key'`;
					return yield* Effect.failCause(cause);
				}),
			mutex,
		);
		const outcome = yield* passkeys.deletePasskey({ id: "key" }, proof, "human").pipe(Effect.exit);
		assert.ok(Exit.isFailure(outcome));
		assert.deepEqual(outcome.cause.reasons, cause.reasons);
		const rollback = Exit.isFailure(fault);
		assert.deepEqual(yield* sql`SELECT counter FROM passkeys`, [{ counter: rollback ? 0 : 1 }]);
		assert.equal((yield* sql`SELECT id FROM auth_challenges`).length, rollback ? 1 : 0);
		yield* sql`DELETE FROM auth_challenges`;
	}
});
await Effect.runPromise(
	run.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer))),
);
await Effect.runPromise(Console.log("auth refusal causes preserved"));
