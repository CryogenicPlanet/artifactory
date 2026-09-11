/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { Clock, Console, Context, Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { EditLock, layer as editLockLayer } from "../../src/edit-lock.ts";
import { Events, layer as eventsLayer } from "../../src/events.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import type { AssertionProof } from "../../src/enrollment.ts";
import type { RevokeFamily } from "../../src/refresh-schema.ts";
import { authenticator } from "./authenticator.ts";

export const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, code?: string) =>
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
					`Expected ${code}`,
				);
		}),
	);
export const tokenSession = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const output: string[] = [];
	const captured: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const context = yield* Layer.build(
		layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
			Layer.provideMerge(Layer.mergeAll(eventsLayer(Effect.void), editLockLayer)),
		),
	).pipe(Effect.provideService(Console.Console, captured));
	const auth = Context.get(context, Auth),
		lock = Context.get(context, EditLock),
		events = Context.get(context, Events);
	const device = authenticator();
	let counter = 0;
	const setup = yield* auth.startSetup(output[0]?.split("code ")[1] ?? "");
	yield* auth.finishSetup(setup.id, device.registration(setup.options.challenge));
	const login = yield* auth.startLogin;
	const session = yield* auth.finishLogin(login.id, device.assertion(login.options.challenge, ++counter));
	const grant = (long = false) =>
		Effect.gen(function* () {
			const enrollment = yield* auth.createEnrollment({ name: "codex", kind: "codex", host: "laptop" });
			const params = {
				id: enrollment.id,
				decision: "approve" as const,
				scopes: ["read", "write", "fs"] as const,
				long_lived: long,
			};
			const started = yield* auth.startEnrollmentAssertion(params);
			yield* auth.decideEnrollment(params, {
				id: started.id,
				response: device.assertion(started.options.challenge, ++counter),
			});
			const pair = yield* auth.collectEnrollment(enrollment.id, enrollment.device_secret);
			assert.equal(pair.status, "collected");
			if (pair.status !== "collected") throw new Error("No pair");
			return pair;
		});
	const proof = (family: string) =>
		Effect.gen(function* () {
			const started = yield* auth.startRevocationAssertion({ family });
			return {
				id: started.id,
				response: device.assertion(started.options.challenge, ++counter),
				challenge: started.options.challenge,
			};
		});
	const live = yield* Clock.Clock;
	let now = yield* Clock.currentTimeMillis;
	const clock: Clock.Clock = {
		sleep: (duration) => live.sleep(duration),
		monotonicTimeNanos: live.monotonicTimeNanos,
		monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
		currentTimeMillis: Effect.sync(() => now),
		currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
		currentTimeMillisUnsafe: () => now,
		currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
	};
	return {
		auth: {
			...auth,
			revokeFamily: (params: RevokeFamily, proof: AssertionProof) => auth.revokeFamily(params, proof, session.id),
		},
		sql,
		lock,
		events,
		grant,
		proof,
		device,
		clock,
		advance: (millis: number) =>
			Effect.sync(() => {
				now += millis;
			}),
		now: () => now,
		output,
	};
});
