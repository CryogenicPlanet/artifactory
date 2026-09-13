import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { it } from "vitest";
const execute = promisify(execFile);

it("keeps unstamped source SQLite-only and reads the frozen manifest rather than editable source", async () => {
	await execute("bun", [join(import.meta.dirname, "fixtures/generation-store-compatibility.ts"), "1"]);
});

it("rejects false, malformed, unknown and excluded engine declarations without trusting links", async () => {
	await execute("bun", [join(import.meta.dirname, "fixtures/generation-store-compatibility.ts"), "2"]);
});

it("rechecks declared support across repeated remote selections without consuming or rewriting it", async () => {
	await execute("bun", [join(import.meta.dirname, "fixtures/generation-store-compatibility.ts"), "3"]);
});

it("refuses incompatible remote startup before fencing or ownership and retains SQLite's filename alias", async () => {
	await execute("bun", [join(import.meta.dirname, "fixtures/generation-store-compatibility.ts"), "4"]);
});
