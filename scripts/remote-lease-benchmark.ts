// Resolve boot's dependencies without introducing root production dependencies.
/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
const child = spawn(
	"bun",
	[join(import.meta.dirname, "../packages/boot/test/fixtures/remote-lease-benchmark.ts"), ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
const [code] = await once(child, "exit");
process.exitCode = typeof code === "number" ? code : 1;
