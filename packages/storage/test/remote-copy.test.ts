import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, type TestContext } from "vitest";
import { Schema } from "effect";
const reportSchema = Schema.fromJsonString(
	Schema.Struct({
		args: Schema.Array(Schema.String),
		env: Schema.Record(Schema.String, Schema.String),
		configPath: Schema.optionalKey(Schema.String),
		config: Schema.optionalKey(Schema.String),
		mode: Schema.optionalKey(Schema.Int),
		pid: Schema.Int,
	}),
);
const readReport = async (root: string) =>
	Schema.decodeUnknownSync(reportSchema)(await readFile(join(root, "report"), "utf8"));

async function fixture(
	test: TestContext,
	engine: "postgres" | "mysql",
	mode: string,
	database = "copy_board",
	tls = false,
) {
	const root = await mkdtemp(join(tmpdir(), "comms-copy-test-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const tool = join(
		root,
		engine === "postgres"
			? mode === "load" || mode === "rebind"
				? "pg_restore"
				: "pg_dump"
			: mode === "load" || mode === "rebind"
				? "mysql"
				: "mysqldump",
	);
	await writeFile(
		tool,
		`#!${process.execPath}
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
const configPath = args[0]?.startsWith('--defaults-file=') ? args[0].slice(16) : undefined;
fs.writeFileSync(root + '/report', JSON.stringify({ args, env: process.env, configPath, config: configPath ? fs.readFileSync(configPath, 'utf8') : undefined, mode: configPath ? fs.statSync(configPath).mode & 511 : undefined, pid: process.pid }));
if (${JSON.stringify(mode)} === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
else if (${JSON.stringify(mode)} === 'fail') { process.stdout.write('partial'); process.stderr.write('dummy secret private SQL'); process.exitCode = 7; }
else if (${JSON.stringify(mode)} === 'load' || ${JSON.stringify(mode)} === 'rebind') { const chunks=[]; process.stdin.on('data', x => chunks.push(x)); process.stdin.on('end', () => fs.writeFileSync(root + '/loaded', Buffer.concat(chunks))); }
else process.stdout.write('complete artifact');
`,
	);
	await chmod(tool, 0o700);
	const run = async () => {
		const output = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/remote-copy.ts"), root, engine, mode, database, tls ? "tls" : "plain"],
			{
				env: {
					...process.env,
					PATH: `${root}:${process.env.PATH}`,
					UNRELATED_SECRET: "must-not-reach-child",
					PGSERVICE: "ambient-override",
				},
			},
		);
		const value: unknown = JSON.parse(output.stdout);
		return { value, text: output.stdout + output.stderr };
	};
	return { root, run };
}
for (const engine of ["postgres", "mysql"] as const) {
	it(`${engine} preserves accepted database names as a single destination value`, async (test) => {
		for (const database of ["team-board", "db=name host=other", "quoted'name"]) {
			const app = await fixture(test, engine, "load", database);
			await writeFile(join(app.root, "artifact"), "native bytes");
			expect((await app.run()).value).toMatchObject({ _tag: "Success" });
			const report = await readReport(app.root);
			expect(report.args).toContain(
				engine === "postgres" ? `dbname='${database.replace(/'/g, "\\'")}'` : `--database=${database}`,
			);
		}
	});

	it(`${engine} dumps a protected artifact without leaking credentials in arguments or inheriting ambient selection`, async (test) => {
		const app = await fixture(test, engine, "dump");
		const result = await app.run();
		expect(result.value).toMatchObject({
			_tag: "Success",
			value: { bytes: 17, engine: engine === "postgres" ? "pg" : "mysql" },
		});
		expect(await readFile(join(app.root, "artifact"), "utf8")).toBe("complete artifact");
		expect((await stat(join(app.root, "artifact"))).mode & 0o777).toBe(0o600);
		const report = await readReport(app.root);
		expect(JSON.stringify(report.args)).not.toContain("dummy");
		expect(report.env.UNRELATED_SECRET).toBeUndefined();
		expect(report.env.PGSERVICE).toBeUndefined();
		if (engine === "mysql") {
			expect(report.mode).toBe(0o600);
			expect(report.config).toContain('password="dummy\\"secret\\\\value"');
			await expect(stat(report.configPath ?? "")).rejects.toThrow();
			expect(report.args).toContain("--no-create-db");
			expect(report.args).not.toContain("--databases");
		} else expect(report.env.PGDATABASE).toBe("copy_board");
	});
	it(`${engine} preserves an existing artifact and removes only its own failed copy`, async (test) => {
		const app = await fixture(test, engine, "fail");
		await writeFile(join(app.root, "artifact"), "existing");
		expect((await app.run()).value).toMatchObject({ _tag: "Failure", failure: { code: "backup_failed" } });
		expect(await readFile(join(app.root, "artifact"), "utf8")).toBe("existing");
		await rm(join(app.root, "artifact"));
		const result = await app.run();
		expect(result.value).toMatchObject({ _tag: "Failure", failure: { code: "backup_failed" } });
		expect(result.text).not.toContain("private SQL");
		await expect(stat(join(app.root, "artifact"))).rejects.toThrow();
	});
	it(`${engine} loads bytes only into the selected destination and rejects a foreign engine`, async (test) => {
		const app = await fixture(test, engine, "load");
		await writeFile(join(app.root, "artifact"), "native bytes");
		expect((await app.run()).value).toMatchObject({ _tag: "Success" });
		expect(await readFile(join(app.root, "loaded"), "utf8")).toBe("native bytes");
		const report = await readReport(app.root);
		expect(report.args).toContain(engine === "postgres" ? "dbname='copy_board'" : "--database=copy_board");
		const foreign = await fixture(test, engine, "foreign");
		expect((await foreign.run()).value).toMatchObject({ _tag: "Failure", failure: { code: "backup_engine_mismatch" } });
		await expect(stat(join(foreign.root, "report"))).rejects.toThrow();
	});
	it(`${engine} rejects descriptor disagreement before creating a file or starting a tool`, async (test) => {
		const app = await fixture(test, engine, "invalid");
		expect((await app.run()).value).toMatchObject({ _tag: "Failure", failure: { code: "copy_target_invalid" } });
		await expect(stat(join(app.root, "artifact"))).rejects.toThrow();
		await expect(stat(join(app.root, "report"))).rejects.toThrow();
	});
	it(`${engine} timeout waits for tool termination and removes its incomplete artifact`, async (test) => {
		const app = await fixture(test, engine, "hang");
		expect((await app.run()).value).toMatchObject({ _tag: "Failure", failure: { code: "rehearsal_copy_timeout" } });
		const report = await readReport(app.root);
		expect(() => process.kill(report.pid, 0)).toThrow();
		await expect(stat(join(app.root, "artifact"))).rejects.toThrow();
		if (engine === "mysql") await expect(stat(report.configPath ?? "")).rejects.toThrow();
	});
}

it("PostgreSQL isolated load removes artifact ownership and ACL replay", async (test) => {
	const app = await fixture(test, "postgres", "rebind");
	await writeFile(join(app.root, "artifact"), "native bytes");
	expect((await app.run()).value).toMatchObject({ _tag: "Success" });
	expect((await readReport(app.root)).args).toEqual([
		"--exit-on-error",
		"--no-owner",
		"--no-acl",
		"--dbname",
		"dbname='copy_board'",
	]);
});
it("MySQL refuses owner rebinding before starting an unsupported loader", async (test) => {
	const app = await fixture(test, "mysql", "rebind");
	await writeFile(join(app.root, "artifact"), "native bytes");
	expect((await app.run()).value).toMatchObject({ _tag: "Failure", failure: { code: "copy_ownership_unsupported" } });
	await expect(stat(join(app.root, "report"))).rejects.toThrow();
});

for (const engine of ["postgres", "mysql"] as const) {
	it(`${engine} native TLS requires authenticated encryption without downgrade`, async (test) => {
		const app = await fixture(test, engine, "dump", "copy_board", true);
		expect((await app.run()).value).toMatchObject({ _tag: "Success" });
		const report = await readReport(app.root);
		if (engine === "postgres") {
			expect(report.env.PGSSLMODE).toBe("verify-full");
			expect(report.env.PGSSLROOTCERT).toBe("system");
		} else {
			expect(report.args).toContain("--ssl-mode=VERIFY_IDENTITY");
			expect(report.args).toContain("--ssl-ca=/etc/ssl/certs/ca-certificates.crt");
		}
	});
}
