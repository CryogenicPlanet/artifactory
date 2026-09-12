import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { ReadResponse } from "../../src/kernel/sql-read-wire.ts";

const Settings = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
it.skipIf(!process.env.COMMS_REMOTE_SQL_READ_TEST_CONFIG)(
	"runs remote SQL in a registered read-only worker and refuses invalid queries",
	async () => {
		const filename = process.env.COMMS_REMOTE_SQL_READ_TEST_CONFIG;
		if (!filename) throw new Error("Missing remote reader fixture configuration");
		const settings = Schema.decodeSync(Schema.fromJsonString(Settings))(await readFile(filename, "utf8"));
		if (settings.database !== "comms_schema_query") throw new Error("Requires isolated query database");
		const url = new URL(`${settings.engine === "pg" ? "postgres" : "mysql"}://localhost`);
		url.hostname = settings.host;
		url.port = String(settings.port);
		url.username = encodeURIComponent(settings.username);
		url.password = encodeURIComponent(settings.password);
		url.pathname = `/${encodeURIComponent(settings.database)}`;
		const bun = (await promisify(execFile)("which", ["bun"])).stdout.trim();
		const setup = (mode: string) =>
			promisify(execFile)(bun, [join(import.meta.dirname, "../fixtures/remote-sql-read.ts"), mode], {
				env: process.env,
				timeout: 10000,
			});
		await setup("prepare");
		let registrations = 0;
		let admit = true;
		// This fixture exercises registration acknowledgement; durable owner proof has separate boot tests.
		const guardian = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				if (request.url !== "/register" || request.headers["x-comms-guardian-secret"] !== "b1".repeat(32)) {
					response.writeHead(403).end();
					return;
				}
				registrations += 1;
				response.writeHead(admit ? 204 : 409).end();
			});
		});
		await new Promise<void>((resolve) => guardian.listen(0, "127.0.0.1", resolve));
		const address = guardian.address();
		if (!address || typeof address === "string") throw new Error("Missing guardian address");
		const query = (sql: string, params: ReadonlyArray<string | number | null> = [], allowRead = true) =>
			new Promise<typeof ReadResponse.Type>((resolve, reject) => {
				const child = spawn(bun, [join(import.meta.dirname, "../../src/kernel/sql-read-worker.ts")], {
					env: {
						REMOTE_ATTEMPT: "a1".repeat(32),
						REMOTE_GUARDIAN_URL: `http://127.0.0.1:${address.port}`,
						REMOTE_GUARDIAN_SECRET: "b1".repeat(32),
						DATABASE_TLS: "false",
					},
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 10000,
				});
				let output = "";
				child.stdout.on("data", (chunk) => {
					output += String(chunk);
				});
				child.stderr.resume();
				child.once("error", reject);
				child.once("close", (code) => {
					if (code !== 0) {
						reject(new Error("Remote reader subprocess failed"));
						return;
					}
					try {
						resolve(Schema.decodeSync(Schema.fromJsonString(ReadResponse))(output.trim()));
					} catch {
						reject(new Error("Invalid remote reader response"));
					}
				});
				child.stdin.end(JSON.stringify({ store: url.href, input: { sql, params }, allowRead }));
			});
		try {
			const placeholder = settings.engine === "pg" ? "$1" : "?";
			expect(await query(`SELECT ${placeholder} AS value`, ["remote"])).toEqual({
				kind: "read",
				result: { rows: [{ value: "remote" }], truncated: false, dialect: settings.engine },
			});
			expect(registrations).toBeGreaterThan(0);
			const capped = await query(
				"WITH RECURSIVE numbers AS (SELECT 1 AS value UNION ALL SELECT value + 1 FROM numbers WHERE value < 205) SELECT value FROM numbers",
			);
			expect(capped).toMatchObject({ kind: "read", result: { truncated: true } });
			if ("kind" in capped && capped.kind === "read") expect(capped.result.rows).toHaveLength(200);
			expect(await query("SELECT repeat('x', 130001) AS value")).toMatchObject({
				error: { code: "sql_query_invalid" },
			});
			expect(await query("WITH item AS (SELECT 7 AS value) SELECT value FROM item")).toMatchObject({
				kind: "read",
				result: { rows: [{ value: 7 }] },
			});
			if (settings.engine === "pg")
				expect(await query("SELECT current_setting('transaction_read_only') AS value")).toMatchObject({
					kind: "read",
					result: { rows: [{ value: "on" }] },
				});
			for (const [sql, params, code, allow] of [
				["SELECT 1; SELECT 2", [], "sql_unsupported", true],
				["DELETE FROM messages", [], "sql_unsupported", true],
				["WITH changed AS (DELETE FROM messages RETURNING *) SELECT * FROM changed", [], "sql_query_invalid", true],
				[`SELECT ${settings.engine === "pg" ? "?" : "$1"} AS value`, [1], "placeholder_style", true],
				["SELECT 1", [], "scope_required", false],
				["SELECT missing_reader_column", [], "sql_query_invalid", true],
			] satisfies ReadonlyArray<readonly [string, ReadonlyArray<number>, string, boolean]>) {
				expect(await query(sql, params, allow)).toMatchObject({ error: { code } });
			}
			expect(await query("SELECT reader_write_probe() AS value")).toMatchObject({
				error: { code: "sql_query_invalid" },
			});
			expect(await query("SELECT value FROM reader_write_probe_rows")).toMatchObject({
				kind: "read",
				result: { rows: [{ value: 0 }] },
			});
			admit = false;
			expect(await query("SELECT 1 AS value")).toMatchObject({ error: { code: "handler_failed" } });
		} finally {
			try {
				await setup("cleanup");
			} finally {
				await new Promise<void>((resolve, reject) => guardian.close((error) => (error ? reject(error) : resolve())));
			}
		}
	},
	30000,
);
