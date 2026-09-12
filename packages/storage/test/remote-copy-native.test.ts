import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";

const Connection = Schema.fromJsonString(
	Schema.Struct({
		host: Schema.String,
		port: Schema.Number,
		database: Schema.String,
		username: Schema.String,
		password: Schema.String,
	}),
);
const readConnection = async (path: string) => Schema.decodeUnknownSync(Connection)(await readFile(path, "utf8"));
const execute = promisify(execFile);
const quoteOption = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const nativeRoot = process.env.COMMS_REMOTE_COPY_CONFIG_ROOT;
// These are disposable native databases provisioned by the acceptance job, never a running board.
for (const engine of ["pg", "mysql"] as const) {
	it.skipIf(!nativeRoot)(
		`${engine} native artifacts preserve data, view and trigger behavior in a differently named database`,
		async (test) => {
			if (!nativeRoot) throw Error("Missing native config root");
			const root = await mkdtemp(join(tmpdir(), "comms-copy-native-"));
			test.onTestFinished(() => rm(root, { recursive: true, force: true }));
			const sourcePath = join(nativeRoot, `${engine}-comms_copy_source.json`);
			const targetPath = join(nativeRoot, `${engine}-comms_copy_target.json`);
			const namedPath = join(nativeRoot, `${engine}-copy-named-target.json`);
			const query = async (configPath: string, sql: string) => {
				const config = await readConnection(configPath);
				if (engine === "pg")
					return (
						await execute(
							"psql",
							["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", sql],
							{
								env: {
									PATH: process.env.PATH,
									PGHOST: config.host,
									PGPORT: String(config.port),
									PGUSER: config.username,
									PGPASSWORD: config.password,
									PGDATABASE: config.database,
									PGPASSFILE: "/dev/null",
								},
							},
						)
					).stdout;
				const file = join(root, "query.cnf");
				await writeFile(
					file,
					`[client]\nhost=${quoteOption(config.host)}\nport=${config.port}\nuser=${quoteOption(config.username)}\npassword=${quoteOption(config.password)}\nprotocol=TCP\n`,
					{ mode: 0o600 },
				);
				return (
					await execute(
						"mysql",
						[
							`--defaults-file=${file}`,
							"--no-login-paths",
							`--database=${config.database}`,
							"--batch",
							"--skip-column-names",
							"--execute",
							sql,
						],
						{ env: { PATH: process.env.PATH } },
					)
				).stdout;
			};
			const clean =
				engine === "pg"
					? "DROP VIEW IF EXISTS copy_view; DROP TABLE IF EXISTS copy_records; DROP TABLE IF EXISTS copy_audit; DROP FUNCTION IF EXISTS copy_trigger();"
					: "DROP VIEW IF EXISTS copy_view; DROP TABLE IF EXISTS copy_records; DROP TABLE IF EXISTS copy_audit;";
			for (const config of [sourcePath, targetPath, namedPath]) {
				await query(config, clean);
				test.onTestFinished(async () => {
					await query(config, clean);
				});
			}
			await query(
				sourcePath,
				engine === "pg"
					? "CREATE TABLE copy_records(id integer PRIMARY KEY, value text, data bytea); CREATE TABLE copy_audit(id integer); CREATE FUNCTION copy_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO copy_audit VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER copy_insert AFTER INSERT ON copy_records FOR EACH ROW EXECUTE FUNCTION copy_trigger(); INSERT INTO copy_records VALUES(1,'retained',decode('00ff','hex')); CREATE VIEW copy_view AS SELECT id,value FROM copy_records;"
					: "CREATE TABLE copy_records(id integer PRIMARY KEY, value text, data blob); CREATE TABLE copy_audit(id integer); CREATE TRIGGER copy_insert AFTER INSERT ON copy_records FOR EACH ROW INSERT INTO copy_audit VALUES(NEW.id); INSERT INTO copy_records VALUES(1,'retained',UNHEX('00ff')); CREATE VIEW copy_view AS SELECT id,value FROM copy_records;",
			);
			for (const [index, destination] of [targetPath, namedPath].entries()) {
				const result = await execute("bun", [
					join(import.meta.dirname, "fixtures/remote-copy-native.ts"),
					sourcePath,
					destination,
					join(root, `artifact-${index}`),
				]);
				expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "Success", value: { engine } });
				expect((await query(destination, "SELECT value FROM copy_view WHERE id=1")).trim()).toBe("retained");
				expect(
					(
						await query(
							destination,
							engine === "pg"
								? "SELECT encode(data,'hex') FROM copy_records WHERE id=1"
								: "SELECT LOWER(HEX(data)) FROM copy_records WHERE id=1",
						)
					).trim(),
				).toBe("00ff");
				await query(destination, "INSERT INTO copy_records(id,value) VALUES(2,'target only')");
				await query(destination, "UPDATE copy_records SET value='target changed' WHERE id=1");
				expect((await query(destination, "SELECT value FROM copy_view WHERE id=1")).trim()).toBe("target changed");
				expect((await query(sourcePath, "SELECT value FROM copy_view WHERE id=1")).trim()).toBe("retained");
				expect((await query(destination, "SELECT COUNT(*) FROM copy_audit")).trim()).toBe("2");
				expect((await query(sourcePath, "SELECT COUNT(*) FROM copy_records")).trim()).toBe("1");
			}
		},
	);
}
