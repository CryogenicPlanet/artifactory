import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = async (mode: string, source: string, target: string) =>
	(
		await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/transfer-copy-native.ts"), mode, source, target],
			{ env: process.env },
		)
	).stdout;
const native = Boolean(process.env.COMMS_TRANSFER_COPY_PG_CONFIG && process.env.COMMS_TRANSFER_COPY_MYSQL_CONFIG);
it.skipIf(!native).for([
	["sqlite", "pg"],
	["sqlite", "mysql"],
	["pg", "sqlite"],
	["mysql", "sqlite"],
	["pg", "mysql"],
	["mysql", "pg"],
])(
	"copies %s to %s through real clients without changing values or identity continuation",
	{ timeout: 30000 },
	async ([source, target]) => {
		if (!source || !target) throw Error("Missing pair");
		expect(await run("pair", source, target)).toContain(`verified ${source}->${target} values, stream and identity`);
	},
);
it.skipIf(!native).for(["pg", "mysql"])(
	"refuses native %s JSON range loss before target writes",
	{ timeout: 30000 },
	async (target) => {
		expect(await run("json-range", "sqlite", target)).toContain(`verified json-range ${target} before writes`);
	},
);
it.skipIf(!process.env.COMMS_TRANSFER_COPY_PACKET_CONFIG)(
	"refuses an actual MySQL packet overflow before target writes",
	async () => {
		expect(await run("packet", "sqlite", "mysql")).toContain("verified packet mysql before writes");
	},
	30000,
);
