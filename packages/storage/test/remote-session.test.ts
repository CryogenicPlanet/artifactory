import { SqlError, UniqueViolation, DeadlockError, SerializationError } from "effect/unstable/sql/SqlError";
import { Cause, Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { sanitized, failure } from "../src/remote-session.ts";

it("drops credential-bearing errors and defects while retaining interruption", async () => {
	for (const effect of [Effect.fail(new Error("private-password")), Effect.die(new Error("private-password"))]) {
		const result = await Effect.runPromiseExit(sanitized(effect, "remote_query_failed"));
		expect(Exit.isFailure(result)).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private-password");
		expect(JSON.stringify(result)).toContain("remote_query_failed");
	}
	const interrupted = await Effect.runPromiseExit(sanitized(Effect.interrupt, "remote_query_failed"));
	expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
});

it("keeps safe conflict categories but removes secret-bearing SQL metadata", async () => {
	for (const reason of [
		new UniqueViolation({ cause: "private-password", message: "private-password", constraint: "private-password" }),
		new DeadlockError({ cause: "private-password", message: "private-password" }),
		new SerializationError({ cause: "private-password", message: "private-password" }),
	]) {
		const result = await Effect.runPromiseExit(sanitized(Effect.fail(new SqlError({ reason })), "remote_query_failed"));
		expect(Exit.isFailure(result)).toBe(true);
		expect(JSON.stringify(result)).toContain(reason._tag);
		expect(JSON.stringify(result)).not.toContain("private-password");
	}
});

it("retains only the static unsupported-isolation refusal through connection sanitization", async () => {
	const denied = await Effect.runPromiseExit(
		sanitized(
			sanitized(Effect.fail(failure("remote_isolation_unsupported")), "remote_connection_failed"),
			"remote_connection_failed",
		),
	);
	expect(Exit.isFailure(denied)).toBe(true);
	expect(JSON.stringify(denied)).toContain("remote_isolation_unsupported");
});
