import { defineConfig } from "vitest/config";

export default defineConfig({
	// Integration files launch real Bun/SQLite processes. Bound concurrency and allow their startup/lifecycle work.
	// Tests that enforce protocol deadlines keep explicit timing assertions and per-test overrides.
	test: {
		maxWorkers: 2,
		testTimeout: 15000,
		expect: { poll: { timeout: 5000 } },
		include: ["packages/*/test/**/*.test.ts"],
		environment: "node",
	},
});
