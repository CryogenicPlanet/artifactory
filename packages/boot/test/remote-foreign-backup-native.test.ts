import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const enabled = process.env.COMMS_REPAIR_CONFIG_DIR && ["pg", "mysql"].includes(process.env.COMMS_REPAIR_ENGINE ?? "");
it.skipIf(!enabled)(
	"a genuine foreign native backup cannot replace the adopted recipient",
	async () => {
		const configs = process.env.COMMS_REPAIR_CONFIG_DIR;
		const engine = process.env.COMMS_REPAIR_ENGINE;
		if (!configs || (engine !== "pg" && engine !== "mysql")) throw new Error("Missing private native configuration");
		const root = await realpath(await mkdtemp(join(tmpdir(), "comms-foreign-backup-")));
		const donor = join(root, "donor"),
			recipient = join(root, "recipient");
		await mkdir(donor);
		await mkdir(recipient);
		// Retain both native target and resource evidence, including on expected identity refusal.
		await writeFile(join(root, "fixture.json"), JSON.stringify({ engine, configs, root }), { flag: "wx", mode: 0o600 });
		const run = async (phase: string, directory: string, pair: string) => {
			const env = { ...process.env };
			delete env.COMMS_REMOTE_ROOT_CONFIG;
			const result = await promisify(execFile)(
				"bun",
				[join(import.meta.dirname, "fixtures/remote-foreign-backup.ts"), directory, phase],
				{
					timeout: 90000,
					env: {
						...env,
						COMMS_REMOTE_TEST_CONFIG: join(configs, `${engine}-repair-${pair}-app.json`),
						COMMS_REMOTE_BOOT_TEST_CONFIG: join(configs, `${engine}-repair-${pair}-boot.json`),
					},
				},
			);
			expect(result.stdout.includes(`FOREIGN_BACKUP_${phase}_VERIFIED`)).toBe(true);
		};
		await run("donor", donor, "foreigndonor");
		for (const name of ["foreign.backup", "donor.json"]) await copyFile(join(donor, name), join(recipient, name));
		expect(
			(await readFile(join(donor, "foreign.backup"))).equals(await readFile(join(recipient, "foreign.backup"))),
		).toBe(true);
		await run("recipient", recipient, "foreignrecipient");
		await run("reopen", recipient, "foreignrecipient");
		expect(
			(await readFile(join(donor, "foreign.backup"))).equals(await readFile(join(recipient, "foreign.backup"))),
		).toBe(true);
	},
	200000,
);
