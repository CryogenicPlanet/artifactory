import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { validateAuthConfig } from "../src/auth-http.ts";
import { originRelyingParty } from "../src/auth-origins.ts";

const valid = (config: Parameters<typeof validateAuthConfig>[0]) =>
	Exit.isSuccess(Effect.runSyncExit(validateAuthConfig(config)));

it("keeps the single-origin RP_ID and PUBLIC_ORIGIN form valid", () => {
	expect(valid({ rpId: "comms.test", expectedOrigin: "https://comms.test" })).toBe(true);
	expect(valid({ rpId: "comms.test", expectedOrigin: "https://board.comms.test" })).toBe(true);
	expect(valid({ rpId: "localhost", expectedOrigin: "http://localhost:8080" })).toBe(true);
	expect(valid({ rpId: "comms.test", expectedOrigin: "https://evil.test" })).toBe(false);
	expect(valid({ rpId: "comms.test", expectedOrigin: "http://comms.test" })).toBe(false);
	expect(valid({ rpId: "comms.test:443", expectedOrigin: "https://comms.test" })).toBe(false);
	expect(valid({ rpId: "comms.test", expectedOrigin: "https://comms.test/path" })).toBe(false);
});

it("validates every additional origin and refuses duplicates", () => {
	const primary = { rpId: "chirp.cryo.wtf", expectedOrigin: "https://chirp.cryo.wtf" };
	const railway = {
		rpId: "chirp-production-36c8.up.railway.app",
		expectedOrigin: "https://chirp-production-36c8.up.railway.app",
	};
	expect(valid({ ...primary, additionalOrigins: [railway] })).toBe(true);
	expect(valid({ ...primary, additionalOrigins: [primary] })).toBe(false);
	expect(valid({ ...primary, additionalOrigins: [{ rpId: "", expectedOrigin: "https://x.test" }] })).toBe(false);
	expect(valid({ ...primary, additionalOrigins: [{ rpId: "x.test", expectedOrigin: "https://user:pw@x.test" }] })).toBe(
		false,
	);
});

it("binds a named origin to its own hostname and refuses anything but an exact origin", () => {
	expect(originRelyingParty("https://chirp.cryo.wtf")).toEqual({
		rpId: "chirp.cryo.wtf",
		expectedOrigin: "https://chirp.cryo.wtf",
	});
	for (const origin of ["https://chirp.cryo.wtf/", "http://chirp.cryo.wtf", "https://*.cryo.wtf", "chirp.cryo.wtf", ""])
		expect(originRelyingParty(origin)).toBeNull();
});
