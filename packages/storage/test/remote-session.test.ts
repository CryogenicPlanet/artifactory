import { SqlError, UniqueViolation, DeadlockError, SerializationError } from "effect/unstable/sql/SqlError";
import { Cause, Effect, Exit, Redacted } from "effect";
import { expect, it } from "vitest";
import { attemptTag, sanitized } from "../src/remote-session.ts";

it("encodes the full attempt below the PostgreSQL handshake limit", async () => {
	const connection = {
		engine: "pg",
		host: "localhost",
		port: 5432,
		database: "app",
		username: "app",
		password: Redacted.make("secret"),
		tls: false,
	} as const;
	const first = await Effect.runPromise(attemptTag({ connection, attempt: "01".repeat(32) }));
	const second = await Effect.runPromise(attemptTag({ connection, attempt: "02".repeat(32) }));
	expect(first).toMatch(/^comms:[A-Za-z0-9_-]{43}$/);
	expect(second).not.toBe(first);
	const invalid = await Effect.runPromiseExit(attemptTag({ connection, attempt: "secret" }));
	expect(Exit.isFailure(invalid)).toBe(true);
	expect(JSON.stringify(invalid)).not.toContain("secret");
});

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
