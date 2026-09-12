// Package-local worker resolves the same runtime dependencies as boot; no extra root dependency.
/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
const child = spawn(
	"bun",
	[join(import.meta.dirname, "../packages/boot/test/fixtures/native-database-benchmark.ts"), ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
const [code] = await once(child, "exit");
process.exitCode = typeof code === "number" ? code : 1;
