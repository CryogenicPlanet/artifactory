// Build only the disposable test worker. The shipped CLI and worker files are never edited.
import assert from "node:assert/strict";
import { resolve } from "node:path";
const [output] = process.argv.slice(2);
assert(output, "Private output path required");
const plan = resolve("packages/server/src/transfer/data-plan.ts");
const adapter = resolve("packages/server/test/fixtures/transfer-copy-crash.ts");
const result = await Bun.build({
	entrypoints: ["packages/server/src/store-transfer-worker.ts"],
	target: "bun",
	packages: "external",
	plugins: [
		{
			name: "disposable-copy-checkpoint",
			setup(build) {
				build.onResolve({ filter: /^@comms\/storage\/transfer-copy$/ }, (args) =>
					args.importer === plan ? { path: adapter } : undefined,
				);
			},
		},
	],
});
assert(result.success && result.outputs.length === 1, "Instrumented worker build failed");
const bundle = result.outputs[0];
assert(bundle, "Instrumented worker bundle missing");
const text = await bundle.text();
assert(text.includes("Instrumented worker checkpoint: messages table committed"), "Copy adapter was not bundled");
await Bun.write(output, text);
