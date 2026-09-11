import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, type TestContext } from "vitest";
import { conversation } from "./conversation.ts";

const backupRows = Schema.Array(
	Schema.Struct({
		id: Schema.String,
		path: Schema.String,
		reason: Schema.String,
		published_through: Schema.Int,
		generation: Schema.Int,
	}),
);
const statusSchema = Schema.Struct({
	child: Schema.Struct({ pid: Schema.NullOr(Schema.Int), generation: Schema.NullOr(Schema.Int), state: Schema.String }),
	traffic: Schema.Struct({ frozen: Schema.Boolean, admitted: Schema.Int, queued: Schema.Int }),
});

/** Accelerates only a disposable boot copy; all capture/drill/process behavior stays real. */
export async function storageFixture(test: TestContext, failDrillClosure = false) {
	const fixture = await conversation(test);
	const execute = promisify(execFile);
	const sql = async (statement: string, store = "comms.db") => {
		const { stdout } = await execute("bun", [
			"-e",
			"import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); try { db.exec('PRAGMA busy_timeout=5000'); process.stdout.write(JSON.stringify(db.query(process.argv[2]).all())); } finally { db.close(); }",
			join(fixture.root, store),
			statement,
		]);
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(stdout);
	};
	const boot = join(fixture.root, "packages/boot");
	await cp(join(import.meta.dirname, "../../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	await cp(
		join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"),
		join(boot, "test/fixtures/launcher.ts"),
	);
	await symlink(join(import.meta.dirname, "../../../boot/node_modules"), join(boot, "node_modules"));
	await mkdir(join(fixture.root, "packages/server"), { recursive: true });
	await symlink(join(import.meta.dirname, "../../node_modules"), join(fixture.root, "packages/server/node_modules"));
	const indexPath = join(boot, "src/index.ts");
	const index = await readFile(indexPath, "utf8");
	const initialize = "yield* initializeBootSchema;";
	expect(index.split(initialize)).toHaveLength(2);
	await writeFile(
		indexPath,
		index.replace(
			initialize,
			`${initialize}\nconst maintenanceSql = yield* SqlClient.SqlClient;
  yield* maintenanceSql\`INSERT OR IGNORE INTO settings(key,value) VALUES('backup.hourly_attempt_at','4102444800000'),('backup.drill_attempt_at','4102444800000')\`;`,
		),
	);
	const maintenancePath = join(boot, "src/storage-maintenance.ts");
	const maintenance = await readFile(maintenancePath, "utf8");
	const pause = 'yield* Effect.sleep("1 minute");';
	expect(maintenance.split(pause)).toHaveLength(2);
	const tick = join(fixture.root, "maintenance-tick");
	await writeFile(
		maintenancePath,
		`import { FileSystem } from "effect";\n${maintenance}`.replace(
			pause,
			`const tickFs = yield* FileSystem.FileSystem; yield* tickFs.writeFileString(${JSON.stringify(tick + ".tmp")}, String((yield* DateTime.nowAsDate).getTime())); yield* tickFs.rename(${JSON.stringify(tick + ".tmp")}, ${JSON.stringify(tick)});\nyield* Effect.sleep("100 millis");`,
		),
	);
	const cutoverPath = join(boot, "src/cutover.ts");
	const cutover = await readFile(cutoverPath, "utf8");
	const acquire = "supervisor.operationGate.withPermit(";
	const endReload = ");\n\tconst optionsSource = options;";
	expect(cutover.split(acquire)).toHaveLength(2);
	expect(cutover.split(endReload)).toHaveLength(2);
	const reloadWaiting = join(fixture.root, "reload-waiting");
	await writeFile(
		cutoverPath,
		cutover
			.replace(
				acquire,
				`fs.writeFileString(${JSON.stringify(reloadWaiting)}, "waiting").pipe(Effect.andThen(${acquire}`,
			)
			.replace(endReload, ")));\n\tconst optionsSource = options;"),
	);
	if (failDrillClosure) {
		const drillPath = join(boot, "src/backup-drill.ts");
		const drill = await readFile(drillPath, "utf8");
		const retire = "yield* supervisor.retire(child);";
		expect(drill.split(retire)).toHaveLength(2);
		await writeFile(
			drillPath,
			drill.replace(
				retire,
				`yield* child.process.stop; yield* fs.writeFileString(child.receipt, "invalid closure proof"); ${retire}`,
			),
		);
	}
	const launch = () =>
		fixture.launch(join(import.meta.dirname, "../../src/server.ts"), join(boot, "test/fixtures/launcher.ts"));
	const force = (kind: "hourly" | "drill" | "both") =>
		sql(
			`UPDATE settings SET value='0' WHERE key ${kind === "both" ? "IN ('backup.hourly_attempt_at','backup.drill_attempt_at')" : `='backup.${kind === "hourly" ? "hourly" : "drill"}_attempt_at'`}`,
			"boot.db",
		);
	const backups = async () =>
		Schema.decodeUnknownSync(backupRows)(
			await sql("SELECT id,path,reason,published_through,generation FROM backups ORDER BY taken_at,id", "boot.db"),
		);
	const drills = () =>
		sql(
			"SELECT json_extract(event,'$.payload.ok') ok FROM events WHERE json_extract(event,'$.type')='backup.drill' ORDER BY seq",
			"boot.db",
		);
	const status = async (url: string, cookie: string) =>
		Schema.decodeUnknownSync(statusSchema)(await (await fetch(`${url}/_boot/status`, { headers: { cookie } })).json());
	const cycle = async () => {
		const before = Number(await readFile(tick, "utf8").catch(() => "0"));
		await expect.poll(async () => Number(await readFile(tick, "utf8").catch(() => "0"))).toBeGreaterThan(before);
	};
	return { ...fixture, sql, launch, force, backups, drills, status, cycle, reloadWaiting };
}
