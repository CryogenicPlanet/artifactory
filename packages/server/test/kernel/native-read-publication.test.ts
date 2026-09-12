import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(!process.env.COMMS_SNAPSHOT_APP_CONFIG || !process.env.COMMS_SNAPSHOT_BOOT_CONFIG)(
	"keeps native storage and ordinary read snapshots across publications and drains read cleanup",
	async () => {
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "../fixtures/native-read-publication.ts")],
			{ timeout: 30000 },
		);
		expect(result.stdout).toContain("NATIVE_READ_PUBLICATION_VERIFIED");
	},
	40000,
);
