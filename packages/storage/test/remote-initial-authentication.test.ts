import { describe, expect, it } from "vitest";
import { AuthenticationError, ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import { initialInspectorFailure } from "../src/remote-driver.ts";
import { RemoteAuthenticationRejected } from "../src/remote-session.ts";

const auth = (cause: unknown, operation = "connect") =>
	new SqlError({ reason: new AuthenticationError({ cause, operation, message: "private driver detail" }) });
describe("initial inspector authentication rejection", () => {
	it("retains only exact engine rejection codes and a static diagnostic", () => {
		for (const [engine, cause, code] of [
			["pg", { code: "28P01", message: "private password" }, "28P01"],
			["mysql", { errno: 1045, sqlState: "28000", sqlMessage: "private password" }, "1045"],
		] as const) {
			const error = initialInspectorFailure(engine, auth(cause));
			expect(error).toBeInstanceOf(RemoteAuthenticationRejected);
			expect(error.message).toBe("remote_authentication_rejected");
			expect(JSON.stringify(error).includes("private")).toBe(false);
			if (error instanceof RemoteAuthenticationRejected)
				expect({ engine: error.engine, code: error.code }).toEqual({ engine, code });
		}
	});
	it("refuses query errors, uncertain transport, malformed codes and generic authentication failures", () => {
		const failures = [
			auth({ code: "28P01" }, "query"),
			auth({ code: "28000" }),
			auth(new Error("SCRAM server proof failed")),
			auth({ errno: 1045 }),
			auth({ errno: "1045", sqlState: "28000" }),
			auth({ errno: 1045, sqlState: "HY000" }),
			new SqlError({
				reason: new ConnectionError({
					cause: { code: "28P01", errno: 1045, sqlState: "28000" },
					operation: "connect",
					message: "private timeout",
				}),
			}),
			{ reason: { _tag: "AuthenticationError", operation: "connect", cause: { code: "28P01" } } },
		];
		for (const engine of ["pg", "mysql"] as const)
			for (const failure of failures) {
				const error = initialInspectorFailure(engine, failure);
				expect(error).not.toBeInstanceOf(RemoteAuthenticationRejected);
				expect(JSON.stringify(error).includes("private")).toBe(false);
			}
		expect(initialInspectorFailure("pg", auth({ errno: 1045, sqlState: "28000" }))).not.toBeInstanceOf(
			RemoteAuthenticationRejected,
		);
		expect(initialInspectorFailure("mysql", auth({ code: "28P01" }))).not.toBeInstanceOf(RemoteAuthenticationRejected);
	});
});
