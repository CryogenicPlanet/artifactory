import { expect, it } from "vitest";
import { logRedactor } from "../src/log-redaction.ts";

it("removes unknown database URL userinfo while retaining useful failure context", () => {
	const redact = logRedactor([]);
	expect(redact("connect MYSQL://alice:p%40ss@db:3306/board failed ECONNREFUSED request=abc")).toBe(
		"connect MYSQL://[redacted]@db:3306/board failed ECONNREFUSED request=abc",
	);
	expect(redact("postgresql://alice@db/board postgres://bob:other@replica/board")).toBe(
		"postgresql://[redacted]@db/board postgres://[redacted]@replica/board",
	);
});

it("removes configured secrets in raw, URL and JSON forms, including standalone decoded passwords", () => {
	const password = 'p@ss /"\\\n?';
	const descriptor = `mysql://fixture:${encodeURIComponent(password)}@db/board`;
	const redact = logRedactor([descriptor]);
	expect(logRedactor(["/?"])("encoded=%2f%3F")).toBe("encoded=[redacted]");
	for (const representation of [
		password,
		encodeURIComponent(password),
		encodeURIComponent(password).replace(/%[A-F0-9]{2}/g, (escape) => escape.toLowerCase()),
		JSON.stringify(password).slice(1, -1),
		JSON.stringify(descriptor),
		encodeURIComponent(descriptor),
	])
		expect(redact(`error ${representation} refused`)).not.toContain(representation);
});

it("owns a snapshot of configured values and preserves unrelated diagnostics", () => {
	const configured = ["initial-secret"];
	const redact = logRedactor(configured);
	configured[0] = "later-secret";
	expect(redact("initial-secret later-secret SQLSTATE=08006 request=abc")).toBe(
		"[redacted] later-secret SQLSTATE=08006 request=abc",
	);
	expect(logRedactor([])("")).toBe("");
	expect(redact(`token=${"a".repeat(64)}`)).toBe("token=[redacted]");
});

it("handles overlapping secrets longest first and never throws on malformed diagnostic values", () => {
	const redact = logRedactor(["secret", "secret-suffix", "", "mysql://bad%zz:password@db", "\ud800"]);
	expect(redact("secret-suffix secret mysql://bad%zz:password@db")).toBe("[redacted] [redacted] mysql://[redacted]@db");
});
