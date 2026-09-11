import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

/** Transport tests seed only a hashed session through the real database, never a boot bypass. */
export async function seedSession(data: string) {
	const token = randomBytes(32).toString("base64url");
	const id = randomBytes(16).toString("hex");
	const hash = createHash("sha256").update(token).digest("hex");
	const execute = promisify(execFile);
	await expect
		.poll(
			async () => {
				try {
					await execute("bun", [
						join(import.meta.dirname, "store.ts"),
						join(data, "boot.db"),
						`INSERT INTO sessions (id, hash, created_at, expires_at) VALUES ('${id}', '${hash}', 0, 9999999999999)`,
					]);
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 5000 },
		)
		.toBe(true);
	return { cookie: `__Host-comms_session=${token}`, id };
}

export const sessionFetch =
	(cookie: string) =>
	(input: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set("cookie", cookie);
		if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method)) headers.set("origin", "https://comms.test");
		return fetch(input, { ...init, headers });
	};
