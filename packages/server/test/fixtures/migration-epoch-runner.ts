import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** Instrument only the boundary after a real preservation check; production has no test callback. */
export const migrationEpochRunner = async () => {
	const directory = await mkdtemp(resolve(import.meta.dirname, "../../.migration-epoch-"));
	try {
		const original = resolve(import.meta.dirname, "migration-epoch-remote.ts");
		const migrationPath = resolve(import.meta.dirname, "../../src/kernel/migrations.ts");
		const absoluteImports = (text: string, base: string) =>
			text.replace(
				/from "(\.\.?\/[^\"]+)"/g,
				(_match: string, name: string) => `from ${JSON.stringify(pathToFileURL(resolve(base, name)).href)}`,
			);
		let migrations = await readFile(migrationPath, "utf8");
		const anchor = 'import { preserveMigrationState } from "./migration-state.ts";';
		assert.equal(migrations.split(anchor).length, 2);
		migrations = migrations.replace(
			anchor,
			`import { preserveMigrationState as preserveOriginal } from "./migration-state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const preserveMigrationState: typeof preserveOriginal = (sql, operation) => preserveOriginal(sql, operation).pipe(
Effect.tap(() => Effect.promise(async () => {
const result = await promisify(execFile)("bun", [${JSON.stringify(original)}, "replace"], { timeout: 10000 });
if (!result.stdout.includes("EPOCH_REPLACED")) throw new Error("Independent epoch replacement did not complete");
})));`,
		);
		await writeFile(`${directory}/migrations.ts`, absoluteImports(migrations, resolve(migrationPath, "..")));
		const fixture = await readFile(original, "utf8");
		const importAnchor = 'import { migrate } from "../../src/kernel/migrations.ts";';
		assert.equal(fixture.split(importAnchor).length, 2);
		await writeFile(
			`${directory}/fixture.ts`,
			absoluteImports(
				fixture.replace(importAnchor, `import { migrate } from ${JSON.stringify(`${directory}/migrations.ts`)};`),
				import.meta.dirname,
			),
		);
		return await promisify(execFile)("bun", [`${directory}/fixture.ts`], { timeout: 30000 });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};
