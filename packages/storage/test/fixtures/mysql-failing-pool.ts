import { writeFileSync } from "node:fs";

/** Disposable child-process replacement for mysql2, testing actual patched adapter ownership. */
export function createPool() {
	return {
		query: (_sql: string, callback: (error: Error) => void) => {
			if (process.env.POOL_PROBE === "failure") callback(new Error("disposable connection failure"));
		},
		end: (callback: () => void) => {
			const marker = process.env.POOL_CLOSED;
			if (!marker) throw new Error("Missing cleanup marker");
			writeFileSync(marker, "closed");
			callback();
		},
	};
}
