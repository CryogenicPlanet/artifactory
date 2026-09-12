// Build-only adapter; the unmodified image CLI still owns the real worker and guardians.
import assert from "node:assert/strict";
import { resolve } from "node:path";
const [output] = process.argv.slice(2);
assert(output, "Private output path required");
const worker = resolve("packages/server/src/transfer/worker.ts");
const adapter = resolve("packages/server/test/fixtures/transfer-retirement-crash.ts");
const result = await Bun.build({
	entrypoints: ["packages/server/src/store-transfer-worker.ts"],
	target: "bun",
	packages: "external",
	plugins: [
		{
			name: "disposable-retirement-checkpoint",
			setup(build) {
				build.onResolve({ filter: /^\.\.\/store-transfer-coordinator\.ts$/ }, (args) =>
					args.importer === worker ? { path: adapter } : undefined,
				);
			},
		},
	],
});
assert(result.success && result.outputs.length === 1, "Instrumented worker build failed");
const bundle = result.outputs[0];
assert(bundle, "Instrumented worker bundle missing");
const text = await bundle.text();
assert(
	text.includes("Instrumented worker checkpoint: source boot retired, app unretired"),
	"Retirement adapter missing",
);
await Bun.write(output, text);
