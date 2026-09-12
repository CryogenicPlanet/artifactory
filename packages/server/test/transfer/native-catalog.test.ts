import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

for (const engine of ["pg", "mysql"] as const) {
	for (const store of ["boot", "app"] as const) {
		const boot = process.env[`COMMS_TRANSFER_CATALOG_${engine.toUpperCase()}_BOOT`];
		const app = process.env[`COMMS_TRANSFER_CATALOG_${engine.toUpperCase()}_APP`];
		it.skipIf(!boot || !app)(
			`projects real ${engine} ${store} catalog including migration ledgers`,
			async () => {
				if (!boot || !app) throw Error("Missing native catalog pair");
				const root = await mkdtemp(join(tmpdir(), "comms-catalog-"));
				try {
					const { stdout } = await promisify(execFile)(
						"bun",
						[
							join(import.meta.dirname, "../fixtures/transfer-native-catalog.ts"),
							boot,
							app,
							join(root, "boot.sqlite"),
							store,
						],
						{ timeout: 30000, env: process.env },
					);
					expect(stdout).toContain(`CATALOG_VERIFIED ${engine} ${store}`);
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			},
			35000,
		);
	}
}
