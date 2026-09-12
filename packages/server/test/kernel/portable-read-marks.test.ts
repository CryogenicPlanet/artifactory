import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const run = async (engine: string) => {
	const result = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "../fixtures/portable-read-marks.ts"), engine],
		{ timeout: 30000 },
	);
	expect(result.stdout).toContain("PORTABLE_READ_MARKS_VERIFIED");
};
it.for(["sqlite", "pglite"])(
	"%s read marks remain monotonic, admitted, epoch-fenced and event-free",
	{ timeout: 40000 },
	run,
);
it.skipIf(!process.env.COMMS_READ_MARK_CONFIG || !process.env.COMMS_READ_MARK_ENGINE)(
	"native read marks retain the portable durability boundary",
	async () => {
		const engine = process.env.COMMS_READ_MARK_ENGINE;
		if (engine !== "pg" && engine !== "mysql") throw new Error("Expected native read-mark engine");
		await run(engine);
	},
	40000,
);
