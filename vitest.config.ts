import { defineConfig } from "vitest/config";

export default defineConfig({
	// Integration files launch several Bun processes each; bound test-run process pressure.
	test: { maxWorkers: 4, include: ["packages/*/test/**/*.test.ts"], environment: "node" },
});
