import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, expect, it, vi } from "vitest";
import { setupPasskey } from "../src/account-passkeys.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["complete", "wrong-code", "cancel", "verify-failed"])("first-passkey registration: %s", async (scenario) => {
	const requests: string[] = [];
	class Attestation {
		clientDataJSON = new Uint8Array([1]).buffer;
		attestationObject = new Uint8Array([2]).buffer;
		getTransports() {
			return ["internal"];
		}
	}
	class Credential {
		id = "credential";
		rawId = new Uint8Array([3]).buffer;
		response = new Attestation();
		getClientExtensionResults() {
			return {};
		}
	}
	const create = vi.fn(async (options: CredentialCreationOptions) => {
		expect(options.publicKey?.challenge).toEqual(new Uint8Array([1, 2, 3]));
		expect(options.publicKey?.user.id).toEqual(new Uint8Array([1, 2, 3]));
		if (scenario === "cancel") throw new DOMException("private browser message", "NotAllowedError");
		return new Credential();
	});
	vi.stubGlobal("window", { location: { origin: "https://board.test" } });
	vi.stubGlobal("navigator", { credentials: { create } });
	vi.stubGlobal("PublicKeyCredential", Credential);
	vi.stubGlobal("AuthenticatorAttestationResponse", Attestation);
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push(url);
		if (url.endsWith("/options")) {
			expect(JSON.parse(String(init?.body))).toEqual({ code: "setup-code" });
			if (scenario === "wrong-code") return Response.json({ error: { code: "setup_code_invalid" } }, { status: 401 });
			return Response.json({
				id: "challenge",
				options: {
					challenge: "AQID",
					rp: { id: "board.test", name: "chirp" },
					user: { id: "AQID", name: "owner", displayName: "owner" },
					pubKeyCredParams: [{ type: "public-key", alg: -7 }],
					timeout: 60000,
				},
			});
		}
		expect(url).toBe("https://board.test/_boot/auth/setup/verify");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			id: "challenge",
			response: { id: "credential", response: { clientDataJSON: "AQ", attestationObject: "Ag" } },
		});
		return scenario === "verify-failed"
			? Response.json({ error: { code: "registration_invalid" } }, { status: 401 })
			: Response.json({ ok: true });
	});
	const result = await Effect.runPromise(
		setupPasskey(" setup-code ").pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch), Effect.result),
	);
	expect(result._tag).toBe(scenario === "complete" ? "Success" : "Failure");
	expect(requests).toHaveLength(scenario === "complete" || scenario === "verify-failed" ? 2 : 1);
	// Registration must never pretend that it has created a login session.
	expect(requests.every((path) => path.includes("/setup/"))).toBe(true);
	if (scenario === "wrong-code") {
		expect(create).not.toHaveBeenCalled();
		if (result._tag === "Failure") expect(result.failure.message).toContain("deployment logs");
	}
	if (scenario === "cancel" && result._tag === "Failure")
		expect(result.failure.message).not.toContain("private browser message");
});
