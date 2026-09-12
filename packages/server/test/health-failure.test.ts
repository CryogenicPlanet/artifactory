import { Cause } from "effect";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import { expect, it } from "vitest";
import { healthFailure } from "../src/kernel/health-failure.ts";
import { KernelError } from "../src/kernel/boot-channel.ts";

it("retains an allowlisted health stage and kernel error code", () => {
	expect(healthFailure("probe", Cause.fail(new KernelError({ code: "health_read_invalid" })))).toBe(
		"Kernel health failed: stage=probe; code=health_read_invalid",
	);
});
it("omits driver and unknown failure text from health diagnostics", () => {
	const secret = "postgres://user:private-password@host/db";
	expect(
		healthFailure(
			"initialize",
			Cause.fail(new SqlError({ reason: new UnknownError({ cause: secret, message: secret, operation: secret }) })),
		),
	).toBe("Kernel health failed: stage=initialize; code=sql_failure");
	expect(healthFailure("probe", Cause.fail(new Error(secret)))).toBe(
		"Kernel health failed: stage=probe; code=unknown_failure",
	);
});
