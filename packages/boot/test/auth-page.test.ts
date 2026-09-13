import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { authClient } from "../src/auth-page.ts";

it.each([
	["network", "options request", "could not reach"],
	["html", "options response", "unreadable response"],
	["redirect", "options response", "was redirected"],
	["decode", "options decode", "could not be prepared"],
	["create", "credential create", "NotAllowedError"],
	["get", "credential get", "NotAllowedError"],
	["verify", "verify request", "could not reach"],
])("identifies %s failures without exposing credential or browser error contents", async (scenario, stage, hint) => {
	const status = { textContent: "" },
		button = { disabled: false };
	let submit: (() => Promise<void>) | undefined;
	const requests: string[] = [];
	const progress: string[] = [];
	const requestId = "1234567890abcdef1234567890abcdef";
	class Attestation {
		clientDataJSON = new Uint8Array([1]).buffer;
		attestationObject = new Uint8Array([2]).buffer;
	}
	const credential = {
		id: "private-credential",
		rawId: new Uint8Array([3]).buffer,
		type: "public-key",
		getClientExtensionResults: () => ({}),
		response: new Attestation(),
	};
	const authenticate = async () => {
		progress.push(status.textContent);
		if (scenario === "create" || scenario === "get") throw new DOMException("private-browser-error", "NotAllowedError");
		return credential;
	};
	runInNewContext(authClient, {
		document: {
			getElementById: (id: string) =>
				id === "status"
					? status
					: id === "code"
						? { value: "private-setup-code" }
						: {
								dataset: { mode: scenario === "get" ? "login" : "setup" },
								querySelector: () => button,
								addEventListener: (
									_name: string,
									callback: (event: { preventDefault: () => void }) => Promise<void>,
								) => {
									submit = () => callback({ preventDefault: () => {} });
								},
							},
		},
		window: {
			isSecureContext: true,
			location: {
				assign: () => {
					throw new Error("Unexpected redirect");
				},
			},
		},
		navigator: { credentials: { create: authenticate, get: authenticate } },
		AuthenticatorAttestationResponse: Attestation,
		URLSearchParams,
		atob,
		btoa,
		Uint8Array,
		fetch: async (path: string, init: RequestInit) => {
			requests.push(path);
			expect(init.redirect).toBe("manual");
			if (scenario === "network" || (scenario === "verify" && path.endsWith("/verify")))
				throw new Error("private-network-error");
			if (scenario === "html") return new Response("private-html", { status: 401 });
			if (scenario === "redirect") return new Response(null, { status: 302 });
			return Response.json(
				{ id: "private-challenge", options: scenario === "decode" ? {} : { challenge: "YWJj", user: { id: "YWJj" } } },
				{ headers: { "x-chirp-request-id": requestId } },
			);
		},
	});
	if (!submit) throw new Error("Missing submit handler");
	await submit();
	expect(status.textContent).toContain(`Stage: ${stage}`);
	expect(status.textContent).toContain(hint);
	expect(status.textContent).not.toContain("private-");
	expect(button.disabled).toBe(false);
	expect(requests).toHaveLength(scenario === "verify" ? 2 : 1);
	if (scenario === "create" || scenario === "get") {
		expect(status.textContent).toContain(requestId);
		expect(progress[0]).toContain("Waiting for your browser");
		expect(status.textContent).toContain("not visible to the server");
	}
});

it("returns to the requested page after sign-in and refuses external targets", async () => {
	const run = async (search: string) => {
		const status = { textContent: "" },
			button = { disabled: false };
		let submit: (() => Promise<void>) | undefined;
		let assigned = "";
		class Assertion {
			clientDataJSON = new Uint8Array([1]).buffer;
			authenticatorData = new Uint8Array([2]).buffer;
			signature = new Uint8Array([3]).buffer;
		}
		const credential = {
			id: "credential",
			rawId: new Uint8Array([4]).buffer,
			type: "public-key",
			getClientExtensionResults: () => ({}),
			response: new Assertion(),
		};
		runInNewContext(authClient, {
			document: {
				getElementById: (id: string) =>
					id === "status"
						? status
						: {
								dataset: { mode: "login" },
								querySelector: () => button,
								addEventListener: (
									_name: string,
									callback: (event: { preventDefault: () => void }) => Promise<void>,
								) => {
									submit = () => callback({ preventDefault: () => {} });
								},
							},
			},
			window: {
				isSecureContext: true,
				location: {
					search,
					assign: (value: string) => {
						assigned = value;
					},
				},
			},
			navigator: { credentials: { get: async () => credential } },
			AuthenticatorAttestationResponse: class {},
			URLSearchParams,
			atob,
			btoa,
			Uint8Array,
			fetch: async () =>
				Response.json(
					{ id: "challenge", options: { challenge: "YWJj" } },
					{ headers: { "x-chirp-request-id": "1234567890abcdef1234567890abcdef" } },
				),
		});
		if (!submit) throw new Error("Missing submit handler");
		await submit();
		return assigned;
	};
	expect(await run("?next=/t/design")).toBe("/t/design");
	expect(await run("?next=https://evil.example")).toBe("/");
	expect(await run("?next=//evil.example")).toBe("/");
	expect(await run("")).toBe("/");
});
