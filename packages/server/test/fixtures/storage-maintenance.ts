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

/** Accelerates the app cron in a disposable source copy; channel/capture/process behavior stays real. */
export async function storageFixture(test: TestContext) {
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
	const server = join(fixture.root, "packages/server/src");
	await cp(join(import.meta.dirname, "../../src"), server, { recursive: true });
	const schedulePath = join(server, "backup-schedule.ts");
	const schedule = await readFile(schedulePath, "utf8");
	const cronImport = 'import { parseCron, runCron } from "./kernel/extension-cron.ts";';
	expect(schedule.split(cronImport)).toHaveLength(2);
	const tick = join(fixture.root, "maintenance-tick");
	const requested = join(fixture.root, "hourly-request");
	await writeFile(
		schedulePath,
		schedule.replace(
			cronImport,
			`
import { Clock, FileSystem } from "effect";
import { parseCron } from "./kernel/extension-cron.ts";
const runCron = <E, R>(_schedule: unknown, run: (at: number) => Effect.Effect<void, E, R>) => Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 while (true) {
  if (yield* fs.exists(${JSON.stringify(requested)})) {
   yield* fs.remove(${JSON.stringify(requested)});
   yield* run(yield* Clock.currentTimeMillis);
  }
  yield* fs.writeFileString(${JSON.stringify(tick + ".tmp")}, String(yield* Clock.currentTimeMillis));
  yield* fs.rename(${JSON.stringify(tick + ".tmp")}, ${JSON.stringify(tick)});
  yield* Effect.sleep("100 millis");
 }
});`,
		),
	);
	const cutoverPath = join(boot, "src/cutover.ts");
	const cutover = await readFile(cutoverPath, "utf8");
	const acquire = "supervisor.operationGate.withPermit(performReload(owner, reloadOptions))";
	expect(cutover.split(acquire)).toHaveLength(2);
	const reloadWaiting = join(fixture.root, "reload-waiting");
	await writeFile(
		cutoverPath,
		cutover.replace(
			acquire,
			`fs.writeFileString(${JSON.stringify(reloadWaiting)}, "waiting").pipe(Effect.andThen(${acquire}))`,
		),
	);
	const launch = () => fixture.launch(join(server, "server.ts"), join(boot, "test/fixtures/launcher.ts"));
	const force = (_kind: "hourly") => writeFile(requested, "due");
	const backups = async () =>
		Schema.decodeUnknownSync(backupRows)(
			await sql("SELECT id,path,reason,published_through,generation FROM backups ORDER BY taken_at,id", "boot.db"),
		);
	const status = async (url: string, cookie: string) =>
		Schema.decodeUnknownSync(statusSchema)(await (await fetch(`${url}/_boot/status`, { headers: { cookie } })).json());
	const cycle = async () => {
		const before = Number(await readFile(tick, "utf8").catch(() => "0"));
		await expect.poll(async () => Number(await readFile(tick, "utf8").catch(() => "0"))).toBeGreaterThan(before);
	};
	return { ...fixture, sql, launch, force, backups, status, cycle, reloadWaiting };
}
